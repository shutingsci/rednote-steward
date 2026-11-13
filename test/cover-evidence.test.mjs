import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256 } from '../src/lib/package.mjs';
import { createCoverEvidence, verifyCoverEvidence, compareCoverImages } from '../src/lib/cover-evidence.mjs';

async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cover-evidence-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const local = path.join(dir, 'approved.png'), platform = path.join(dir, 'readback.png');
  const bytes = Buffer.from('synthetic unchanged cover');
  await fs.writeFile(local, bytes); await fs.writeFile(platform, bytes);
  const task = { id: 'task-original', fingerprint: 'frozen', account_user_id: 'account-1', source_note_id: 'a'.repeat(24), cover: { path: local, sha256: sha256(bytes) } };
  const row = { noteId: task.source_note_id, cover: { url: 'https://sns.xhscdn.com/cover.png' }, coverContent: { sha256: sha256(bytes), bytes: bytes.length } };
  const file = path.join(dir, 'receipt.json');
  return { dir, local, platform, bytes, task, row, file };
}

test('cover evidence recomputes local bytes and binds the current authenticated cover digest', async t => {
  const f = await fixture(t); const evidence = await createCoverEvidence(f.task, f.row, f.platform);
  assert.equal(evidence.comparison.method, 'sha256'); assert.equal(evidence.comparison.matched, true);
  await fs.writeFile(f.file, JSON.stringify(evidence));
  const verified = await verifyCoverEvidence(f.file, f.task, f.row);
  assert.equal(verified.comparison.matched, true); assert.equal(verified.originalReadAt, evidence.readAt);
  assert.equal('selectionVerified' in verified, false);
  for (const changed of [ { ...f.row, coverContent: null }, { ...f.row, coverContent: { ...f.row.coverContent, sha256: '0'.repeat(64) } } ]) {
    await assert.rejects(verifyCoverEvidence(f.file, f.task, changed), /bound browser bytes/);
  }
});

test('cover receipts cannot cross task, fingerprint, account, note or current cover bindings', async t => {
  const f = await fixture(t); const evidence = await createCoverEvidence(f.task, f.row, f.platform);
  for (const field of ['taskId', 'fingerprint', 'accountUserId', 'noteId']) {
    await fs.writeFile(f.file, JSON.stringify({ ...evidence, [field]: 'other' }));
    await assert.rejects(verifyCoverEvidence(f.file, f.task, f.row), /does not bind/);
  }
  await fs.writeFile(f.file, JSON.stringify(evidence));
  await assert.rejects(verifyCoverEvidence(f.file, f.task, { ...f.row, cover: { url: 'https://sns.xhscdn.com/other.png' } }), /does not bind/);
  const renewedSignature = { ...f.row, cover: { url: 'https://sns.xhscdn.com/cover.png?sign=renewed&t=next' } };
  assert.equal((await verifyCoverEvidence(f.file, f.task, renewedSignature)).comparison.matched, true);
  await fs.appendFile(f.platform, 'modified');
  await assert.rejects(verifyCoverEvidence(f.file, f.task, f.row), /bytes changed/);
});

test('reported matching text cannot override independently recomputed image differences', async t => {
  const f = await fixture(t); const different = Buffer.from('different synthetic cover');
  await fs.writeFile(f.platform, different);
  f.row.coverContent = { sha256: sha256(different), bytes: different.length };
  const compare = async () => ({ method: 'image-ssim', threshold: 0.995, score: 0.2, matched: false });
  const evidence = await createCoverEvidence(f.task, f.row, f.platform, { compare });
  await fs.writeFile(f.file, JSON.stringify({ ...evidence, comparison: { ...evidence.comparison, score: 1, matched: true } }));
  await assert.rejects(verifyCoverEvidence(f.file, f.task, f.row, { compare }), /no longer matches/);
});

test('image comparison keeps decoder failures and unsupported transformed images unresolved', async () => {
  const unavailable = await compareCoverImages(Buffer.from('a'), Buffer.from('b'), { runner: async () => { throw new Error('tool unavailable'); } });
  assert.equal(unavailable.matched, false); assert.equal(unavailable.reason, 'comparison-unavailable');
  let probes = 0;
  const changed = await compareCoverImages(Buffer.from('a'), Buffer.from('b'), { runner: async () => ({ stdout: JSON.stringify({ streams: [{ width: probes++ ? 100 : 200, height: 100 }] }) }) });
  assert.equal(changed.matched, false);
});

test('image comparison accepts one high-scoring platform 4:3 crop', async () => {
  let probes = 0;
  const runner = async (command, args) => {
    if (command === 'ffprobe') {
      const approved = args.at(-1).endsWith('/approved');
      const dimensions = approved ? { width: 1280, height: 720 } : { width: 1192, height: 894 };
      probes++;
      return { stdout: JSON.stringify({ streams: [dimensions] }) };
    }
    const filter = args[args.indexOf('-filter_complex') + 1];
    const score = filter.includes('crop=960:720:0:0') ? '0.991' : '0.900';
    return { stderr: `[Parsed_ssim_4] SSIM Y:0.990 U:0.990 V:0.990 All:${score}` };
  };
  const result = await compareCoverImages(Buffer.from('a'), Buffer.from('b'), { runner });
  assert.equal(result.method, 'image-ssim-platform-crop');
  assert.equal(result.cropAlignment, 'left');
  assert.equal(result.score, 0.991);
  assert.equal(result.matched, true);
});

test('image comparison rejects ambiguous or low-scoring platform crops', async () => {
  for (const [score, reason] of [[0.990, 'crop-alignment-ambiguous'], [0.85, undefined]]) {
    let probes = 0;
    const runner = async (command, args) => {
      if (command === 'ffprobe') {
        const approved = args.at(-1).endsWith('/approved');
        const dimensions = approved ? { width: 1280, height: 720 } : { width: 1192, height: 894 };
        probes++;
        return { stdout: JSON.stringify({ streams: [dimensions] }) };
      }
      return { stderr: `[Parsed_ssim_4] SSIM Y:0.9 U:0.9 V:0.9 All:${score}` };
    };
    const result = await compareCoverImages(Buffer.from('a'), Buffer.from('b'), { runner });
    assert.equal(result.matched, false);
    if (reason) assert.equal(result.reason, reason);
  }
});

test('bound browser cover hashing limits its destination and verifies the observed bytes', async () => {
  const { readCoverHash } = await import('../adapters/opencli/xiaohongshu/steward-read-note.js');
  const { webcrypto } = await import('node:crypto'); const vm = await import('node:vm');
  const bytes = Buffer.from('synthetic platform response'); let calls = 0;
  const page = { evaluate: async source => vm.runInNewContext(source, { URL, AbortController, setTimeout, clearTimeout, Uint8Array,
    crypto: webcrypto, fetch: async (_url, options) => {
      calls++; assert.equal(options.redirect, 'error');
      return new Response(bytes);
    } }) };
  const result = await readCoverHash(page, 'https://sns.xhscdn.com/cover.png');
  assert.equal(result.sha256, sha256(bytes)); assert.equal(result.bytes, bytes.length);
  for (const url of ['http://sns.xhscdn.com/cover', 'https://xhscdn.com.attacker.invalid/cover', 'https://localhost/cover', 'https://user@sns.xhscdn.com/cover']) {
    await assert.rejects(readCoverHash(page, url), /outside the platform/);
  }
  assert.equal(calls, 1);
});

test('bound browser cover hashing rejects failed or oversized reads', async () => {
  const { readCoverHash } = await import('../adapters/opencli/xiaohongshu/steward-read-note.js');
  const { webcrypto } = await import('node:crypto'); const vm = await import('node:vm');
  for (const response of [new Response('', { status: 403 }), new Response(Buffer.alloc(20 * 1024 * 1024 + 1))]) {
    const page = { evaluate: source => vm.runInNewContext(source, { URL, AbortController, setTimeout, clearTimeout, Uint8Array,
      crypto: webcrypto, fetch: async () => response }) };
    await assert.rejects(readCoverHash(page, 'https://sns.xhscdn.com/cover.png'), /cover download failed|cover size/);
  }
});
