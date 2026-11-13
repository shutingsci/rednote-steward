import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sha256 } from './package.mjs';
import { videoSourceIdentity } from './media.mjs';

const exec = promisify(execFile);
const MAX_BYTES = 20 * 1024 * 1024;
const THRESHOLD = 0.995;
const CROP_THRESHOLD = 0.90;

async function readImage(file) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || !stat.size || stat.size > MAX_BYTES) throw new Error('Cover evidence requires a nonempty image of at most 20 MiB');
  const bytes = await fs.readFile(file);
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error('Cover evidence image size changed');
  return bytes;
}
// Compare immutable local snapshots. Unknown decoding or a low score never matches.
export async function compareCoverImages(local, platform, { runner = exec } = {}) {
  if (local.equals(platform)) return { method: 'sha256', threshold: null, score: 1, matched: true };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rednote-cover-'));
  try {
    const left = path.join(dir, 'approved'), right = path.join(dir, 'readback');
    await fs.writeFile(left, local, { mode: 0o600 }); await fs.writeFile(right, platform, { mode: 0o600 });
    const dimensions = async file => {
      const { stdout } = await runner('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file], { timeout: 30_000, maxBuffer: 1024 * 1024 });
      const stream = JSON.parse(stdout).streams?.[0];
      if (!(stream?.width > 0 && stream?.height > 0)) throw new Error('Cover dimensions unavailable');
      return stream.width / stream.height;
    };
    const [a, b] = await Promise.all([dimensions(left), dimensions(right)]);
    const normalize = 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2,format=yuv444p,setpts=PTS-STARTPTS';
    const compare = async (filterComplex) => {
      const { stderr } = await runner('ffmpeg', ['-hide_banner', '-nostats', '-i', left, '-i', right,
        '-filter_complex', filterComplex, '-frames:v', '1', '-an', '-f', 'null', '-'],
      { timeout: 30_000, maxBuffer: 1024 * 1024 });
      const value = [...stderr.matchAll(/SSIM[^\r\n]*\bAll:([0-9.]+)/g)].at(-1)?.[1];
      const score = value == null ? null : Number(value);
      return Number.isFinite(score) && score <= 1 ? score : null;
    };
    if (Math.abs(a - b) / a <= 0.01) {
      const score = await compare(`[0:v]${normalize}[a];[1:v]${normalize}[b];[a][b]ssim`);
      return { method: 'image-ssim', threshold: THRESHOLD, score,
        matched: score != null && score >= THRESHOLD };
    }
    // The video editor can display a wider approved frame with a 4:3 cover
    // crop. Compare both possible full-height crops to the saved 4:3 image,
    // then require a high score from the unique best crop. A different image,
    // decoder failure or ambiguous near-tie remains unresolved.
    const scores = [];
    for (const align of ['left', 'center', 'right']) {
      // Pixel dimensions are exact and avoid `mdar`, which older ffmpeg builds
      // may not expose in crop expressions.
      const dimensions = async file => {
        const { stdout } = await runner('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
          '-show_entries', 'stream=width,height', '-of', 'json', file],
        { timeout: 30_000, maxBuffer: 1024 * 1024 });
        return JSON.parse(stdout).streams?.[0];
      };
      const baseDimensions = await dimensions(left);
      const cropHeight = Number(baseDimensions?.height);
      const cropWidth = Math.min(
        Number(baseDimensions?.width),
        Math.round(cropHeight * b),
      );
      const maxX = Math.max(0, Number(baseDimensions?.width) - cropWidth);
      const x = align === 'left' ? 0 : align === 'center' ? Math.round(maxX / 2) : maxX;
      const filter = `crop=${cropWidth}:${cropHeight}:${x}:0`;
      const score = await compare(`[0:v]${filter},${normalize}[a];[1:v]${normalize}[b];[a][b]ssim`);
      if (score != null) scores.push({ align, score });
    }
    scores.sort((x, y) => y.score - x.score);
    const best = scores[0] ?? null;
    const ambiguous = scores.length > 1 && best.score - scores[1].score < 0.005;
    return { method: 'image-ssim-platform-crop', threshold: CROP_THRESHOLD,
      score: best?.score ?? null, matched: Boolean(best && best.score >= CROP_THRESHOLD && !ambiguous),
      ...(best ? { cropAlignment: best.align } : {}),
      ...(ambiguous ? { reason: 'crop-alignment-ambiguous' } : {}) };
  } catch { return { method: 'image-ssim', threshold: THRESHOLD, score: null, matched: false, reason: 'comparison-unavailable' }; }
  finally { await fs.rm(dir, { recursive: true, force: true }); }
}

export async function createCoverEvidence(task, row, platformPath, { compare = compareCoverImages } = {}) {
  if (!task.cover?.path || !task.cover.sha256 || !row?.cover?.url || row.noteId !== (task.platform_note_id || task.source_note_id)) {
    throw new Error('Cover evidence requires a frozen cover and the exact original note');
  }
  const [local, platform] = await Promise.all([readImage(task.cover.path), readImage(platformPath)]);
  if (sha256(local) !== task.cover.sha256) throw new Error('Frozen cover changed after ingest');
  if (row.coverContent?.sha256 !== sha256(platform) || row.coverContent?.bytes !== platform.length) throw new Error('Saved platform cover does not match the current bound browser bytes');
  return { schemaVersion: 1, kind: 'rednote_cover_content_evidence', taskId: task.id, fingerprint: task.fingerprint,
    accountUserId: task.account_user_id, noteId: row.noteId, readAt: new Date().toISOString(),
    local: { path: task.cover.path, sha256: sha256(local) },
    platform: { path: path.resolve(platformPath), sha256: sha256(platform), url: row.cover.url },
    comparison: await compare(local, platform),
    scope: 'cover-content-only; submission, moderation and public visibility not established' };
}
export async function verifyCoverEvidence(file, task, row, dependencies) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > 64 * 1024) throw new Error('Cover evidence receipt must be a JSON file of at most 64 KiB');
  const previous = JSON.parse(await fs.readFile(file, 'utf8'));
  if (previous.schemaVersion !== 1 || previous.kind !== 'rednote_cover_content_evidence' || previous.taskId !== task.id ||
      previous.fingerprint !== task.fingerprint || previous.accountUserId !== task.account_user_id || previous.noteId !== row.noteId ||
      previous.local?.path !== task.cover?.path || previous.local?.sha256 !== task.cover?.sha256 ||
      videoSourceIdentity(previous.platform?.url) !== videoSourceIdentity(row.cover?.url) ||
      !Number.isFinite(Date.parse(previous.readAt)) || Date.parse(previous.readAt) > Date.now() || !previous.platform?.path ||
      !/^[a-f0-9]{64}$/.test(previous.platform?.sha256 ?? '') || !previous.comparison ||
      !['sha256', 'image-ssim', 'image-ssim-platform-crop'].includes(previous.comparison.method) ||
      typeof previous.comparison.matched !== 'boolean') {
    throw new Error('Cover evidence does not bind this frozen account task and current note');
  }
  const local = await readImage(task.cover.path);
  const platform = await readImage(previous.platform.path);
  if (sha256(local) !== task.cover.sha256 || sha256(platform) !== previous.platform.sha256) throw new Error('Cover evidence bytes changed since the evidence receipt');
  if (row.coverContent?.sha256 !== previous.platform.sha256 || row.coverContent?.bytes !== platform.length) throw new Error('Cover evidence does not match current bound browser bytes');
  const comparison = await (dependencies?.compare || compareCoverImages)(local, platform);
  if (comparison.matched !== true) throw new Error('Cover evidence no longer matches the frozen cover');
  return { ...previous, local: { ...previous.local, sha256: sha256(local) }, platform: { ...previous.platform, sha256: sha256(platform) }, comparison,
    sourceReceipt: path.resolve(file), originalReadAt: previous.readAt };
}
