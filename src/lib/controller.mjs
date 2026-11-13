import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { reviewItem, reviewRevision } from './review.mjs';
import { stateRoot, privateDirectory, getAccount, listAccounts } from './config.mjs';
import { openDatabase, transaction, addEvent, rowToTask, claimTask, claimNextTask, taskPause, setTaskPhase, recordWorkerLaunch } from './db.mjs';
import { inspectPackage, verifyFrozenPackage, normalizeText } from './package.mjs';
import { publishArgs, editArgs, readInventory, readNote, readMetrics, runOpencli, verifiedIdentity, rowOf } from './opencli.mjs';
import { auditRows, reviewCandidates } from './audit.mjs';
import { videoSourceChanged, videoSourceIdentity } from './media.mjs';
import { createCoverEvidence, verifyCoverEvidence } from './cover-evidence.mjs';
import { acquireAccountWrite, resolveAccountWrite } from './owner.mjs';
import { importInventory, catalogNotes, updateCatalogNote, consolidateCatalogNotes, catalogReceipts, upsertSeries, seriesOverview,
  inspectionCandidates, getAccountPolicy, setAccountPolicy, getInspectionCursor, setInspectionCursor } from './catalog.mjs';

const now = () => new Date().toISOString();
const serialize = value => value == null ? null : JSON.stringify(value);
function resultData(response, label) {
  if (response.exitCode !== 0 || response.json == null) throw adapterError(response, `${label} returned no data`);
  return response.json;
}
function adapterError(response, fallback) {
  const structured = rowOf(response.json)?.error;
  const detail = structured && typeof structured === 'object' ? structured : null;
  const error = new Error(response.timedOut ? 'Adapter timed out; submission result is unknown'
    : detail?.message || (typeof structured === 'string' ? structured : '') || response.stderr?.trim() || fallback);
  error.code = detail?.code || (response.timedOut ? 'adapter_timeout' : 'adapter_failed');
  error.detail = { ...(detail || {}), exitCode: response.exitCode, timedOut: Boolean(response.timedOut),
    ...(response.stderr?.trim() ? { stderr: response.stderr.trim().slice(0, 4096) } : {}) };
  return error;
}
function batchIdentifier(value) {
  if (value == null) return null;
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('Batch ID must use letters, numbers, _ or -');
  return value;
}
function checkNoteId(id) {
  if (!/^[a-f0-9]{24}$/i.test(id ?? '')) throw new Error('A 24-character platform note ID is required');
  return id.toLowerCase();
}
function activeProcess(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function unchangedNote(before, after) {
  const fieldsReadable = row => row?.verification?.title === true && row?.verification?.body === true
    && row?.verification?.nativeTopics === true && Array.isArray(row.topics)
    && row.topics.every(topic => topic?.id && topic?.name);
  if (!fieldsReadable(before) || !fieldsReadable(after) || before.noteId !== after.noteId) return false;
  const topics = row => JSON.stringify((row.topics || []).map(topic => [topic.id, topic.name]).sort());
  if (before.title !== after.title || normalizeText(before.body) !== normalizeText(after.body)
    || topics(before) !== topics(after) || before.mediaType !== after.mediaType) return false;
  const source = videoSourceIdentity;
  if (before.mediaType === 'video') {
    if (!before.videoPresent || !after.videoPresent || !source(before.video?.src)
      || source(before.video.src) !== source(after.video?.src)
      || (before.video?.duration > 0 && after.video?.duration > 0
        && Math.abs(before.video.duration - after.video.duration) > 0.25)) return false;
  } else if (before.mediaType === 'image') {
    if (before.verification.imageCount !== true || after.verification.imageCount !== true
      || before.imageCount !== after.imageCount || !before.images?.length
      || before.images.length !== before.imageCount || after.images?.length !== before.images.length) return false;
    for (let index = 0; index < before.images.length; index++) {
      if (!source(before.images[index].url) || source(before.images[index].url) !== source(after.images[index].url)) return false;
    }
  } else return false;
  if (before.cover?.url || after.cover?.url) {
    if (!source(before.cover?.url) || source(before.cover.url) !== source(after.cover?.url)) return false;
  }
  return true;
}
function stagedPublication(task, events, publication) {
  const attemptStart = events.findLastIndex(event => event.event === 'execution_claimed'
    && event.payload?.attemptId === task.attempt_id);
  const current = task.attempt_id ? (attemptStart < 0 ? [] : events.slice(attemptStart)) : events;
  const finished = current.findLast(event => event.event === 'adapter_finished'
    && (!event.payload?.attemptId || event.payload.attemptId === task.attempt_id));
  publication ??= finished?.payload?.publication ?? null;
  const coverEvents = current.filter(event => event.event === 'phase'
    && event.payload?.detail?.stage === 'cover-and-copy'
    && event.payload.detail.noteId === task.source_note_id
    && (!task.attempt_id || event.payload.detail.attemptId === task.attempt_id));
  const prepared = coverEvents.findLast(event => event.payload.phase === 'prepared')?.payload.detail;
  const attempted = coverEvents.findLast(event => event.payload.phase === 'submit_attempted')?.payload.detail;
  if (!prepared && !attempted) return publication;
  return { ...publication, cover: { ...prepared?.cover, ...attempted?.cover, ...publication?.cover,
    ...(prepared?.preCoverSource ? { preCoverSource: prepared.preCoverSource } : {}),
    ...(attempted ? { submissionAttempted: true } : {}) } };
}
export function compareReadback(task, row, publication = null, coverContentEvidence = null) {
  const expectedId = task.platform_note_id || task.source_note_id;
  const topics = Array.isArray(row?.topics) ? row.topics : [];
  const expectedTopics = [...task.topics].sort();
  const actualTopics = topics.map(topic => typeof topic === 'object' ? topic.name : topic).sort();
  const nativeTopics = topics.every(topic => typeof topic === 'object' && String(topic.id ?? '').length > 0);
  const checks = {
    noteId: Boolean(row?.noteId && (!expectedId || row.noteId === expectedId)),
    title: row?.verification?.title === true && row.title === task.title,
    body: row?.verification?.body === true && normalizeText(row.body) === normalizeText(task.body),
    topics: row?.verification?.nativeTopics === true && nativeTopics && JSON.stringify(actualTopics) === JSON.stringify(expectedTopics),
  };
  const expectedDeclarations = task.declarations && Object.keys(task.declarations).length ? task.declarations : null;
  if (expectedDeclarations) checks.declarations = row?.declarations?.verification === 'saved-composer-controls'
    && Object.entries(expectedDeclarations).every(([key,value]) => row.declarations.values?.[key] === value);
  const baseline = task.baseline_note;
  if (task.video || task.cover) {
    checks.media = row?.mediaType === 'video' && row?.videoPresent === true && Boolean(row.video?.src);
    if (task.kind === 'edit' && task.video) {
      checks.videoReplacement = videoSourceChanged(baseline?.video?.src, row?.video?.src);
      const preparedDuration = publication?.replacement?.prepared?.duration;
      if (preparedDuration > 0 && row?.video?.duration > 0) {
        checks.videoDuration = Math.abs(row.video.duration - preparedDuration) <= 0.5;
      }
    } else if (task.kind === 'edit' && task.cover) {
      checks.videoPreserved = Boolean(videoSourceIdentity(baseline?.video?.src)
        && videoSourceIdentity(baseline.video.src) === videoSourceIdentity(row?.video?.src));
    }
    if (task.cover) {
      if (task.kind === 'edit') {
        const staged = publication?.cover || {};
        const preCoverSource = staged.preCoverSource;
        const savedSource = videoSourceIdentity(row?.cover?.url);
        // Xiaohongshu may transcode the selected image to a different resource path.
        const coverSourceChanged = videoSourceChanged(preCoverSource, row?.cover?.url) && Boolean(savedSource);
        checks.customCover = Boolean(
          staged.selectionVerified
          && staged.confirmationClicked
          && typeof staged.source === 'string' && /^(https?:|blob:)/.test(staged.source)
          && (staged.saveVerified === true || staged.identityVerifiedAfterSave === true || staged.submissionAttempted === true)
          && coverSourceChanged
          && row?.cover?.url
        );
      } else {
        checks.customCover = Boolean(publication?.cover?.confirmationClicked && row?.cover?.url);
      }
    }
  } else if (task.images.length) {
    checks.media = row?.mediaType === 'image' && row?.verification?.imageCount === true && row.imageCount === task.images.length;
  } else if (baseline?.mediaType === 'video') {
    checks.media = row?.mediaType === 'video' && row.videoPresent === true;
  } else {
    checks.media = Boolean(baseline && row?.verification?.imageCount === true && row.imageCount === baseline.imageCount && row.mediaType === baseline.mediaType);
  }
  const contentCoverMatched = Boolean(task.cover && coverContentEvidence?.comparison?.matched === true
    && coverContentEvidence.taskId === task.id && coverContentEvidence.fingerprint === task.fingerprint
    && coverContentEvidence.accountUserId === task.account_user_id && coverContentEvidence.noteId === row?.noteId
    && coverContentEvidence.local?.sha256 === task.cover.sha256
    && videoSourceIdentity(coverContentEvidence.platform?.url) === videoSourceIdentity(row?.cover?.url));
  if (task.cover && coverContentEvidence) checks.customCover = contentCoverMatched;
  return {
    matched: Object.values(checks).every(Boolean), checks,
    ...(coverContentEvidence ? { coverContentEvidence } : {}),
    scope: 'Observable title, body, native topics, media presence/count and changed video resource for replacements',
    limits: { mediaBytes: 'not-compared', imageOrder: 'platform-urls-only',
      videoReplacement: task.kind === 'edit' && task.video
        ? (checks.videoReplacement ? 'saved-source-changed; bytes-not-compared' : 'unconfirmed') : 'not-requested',
      customCover: task.cover ? (contentCoverMatched ? 'current-platform-content-recomputed' : checks.customCover
        ? task.kind === 'edit' ? 'selection-confirmed-and-saved-resource-changed; transformed-bytes-not-compared' : 'selection-confirmed-and-cover-present'
        : 'not-confirmed') : 'not-requested',
      declarations: expectedDeclarations ? (checks.declarations ? 'saved-composer-controls-match' : 'saved fields unconfirmed') : 'not-requested',
      publicVisibility: 'not-evaluated', moderation: 'not-evaluated' },
  };
}

export class Controller {
  constructor(root = stateRoot()) { this.root = root; this.dbPath = path.join(root, 'xhs-ops.sqlite'); }
  database() { return openDatabase(this.dbPath); }
  withDatabase(fn) { const db = this.database(); try { return fn(db); } finally { db.close(); } }
  withReadDatabase(fn, empty = { ok: true, notes: [] }) {
    if (!existsSync(this.dbPath)) return empty;
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    try { return fn(db); } finally { db.close(); }
  }
  init() {
    privateDirectory(this.root); privateDirectory(path.join(this.root, 'receipts'));
    this.withDatabase(() => {});
    return { ok: true, home: this.root, database: this.dbPath, accounts: listAccounts() };
  }
  show(id) {
    return this.withDatabase(db => {
      const task = rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
      if (!task) throw new Error(`Task not found: ${id}`);
      const events = db.prepare('SELECT event, payload_json, created_at FROM events WHERE task_id = ? ORDER BY id').all(id)
        .map(({ payload_json, ...row }) => ({ ...row, payload: payload_json ? JSON.parse(payload_json) : null }));
      return { ok: true, task, events };
    });
  }
  plan({ account, batchId, all = false } = {}) {
    return this.withDatabase(db => {
      const where = [all ? '1 = 1' : "state IN ('draft','queued','paused','running','submitted','needs_review','failed')"];
      const params = [];
      if (account) { where.push('account = ?'); params.push(account); }
      if (batchId) { where.push('batch_id = ?'); params.push(batchIdentifier(batchId)); }
      const tasks = db.prepare(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY COALESCE(scheduled_at,created_at),created_at`).all(...params).map(rowToTask);
      for (const task of tasks) {
        const blocker = db.prepare(`SELECT id,state FROM tasks WHERE id<>? AND state IN ('running','submitted','needs_review')
          AND (account_user_id=? OR browser_profile=? OR account=?) LIMIT 1`)
          .get(task.id, task.account_user_id, task.browser_profile, task.account);
        const pause = taskPause(db,task);
        task.execution = { eligible: task.state === 'queued' && (!task.scheduled_at || task.scheduled_at <= now()) && !blocker && !pause,
          ...(blocker ? { blocker } : {}), ...(pause ? { pause } : {}), ...(task.state === 'paused' ? { reason: task.pause_reason || 'paused' } : {}) };
      }
      return { ok: true, tasks, executable: tasks.filter(task => task.execution.eligible).length };
    });
  }
  async review({ taskId, account, fingerprint, revision } = {}) {
    if (!taskId && (fingerprint || revision)) throw new Error('An exact task ID is required with a fingerprint or revision');
    if (!existsSync(this.dbPath)) {
      if (taskId) throw new Error(`Task not found: ${taskId}`);
      return { ok: true, items: [] };
    }
    // A preview neither initializes/migrates the database nor adds review state.
    const db = new DatabaseSync(this.dbPath, { readOnly: true });
    let snapshots;
    try {
      db.exec('BEGIN');
      const tasks = taskId ? [rowToTask(db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId))]
        : db.prepare(`SELECT * FROM tasks ${account ? 'WHERE account = ?' : ''} ORDER BY updated_at DESC`).all(...(account ? [account] : [])).map(rowToTask);
      if (taskId && !tasks[0]) throw new Error(`Task not found: ${taskId}`);
      snapshots = tasks.map(task => ({ task, events: db.prepare('SELECT event, payload_json, created_at FROM events WHERE task_id = ? ORDER BY id').all(task.id)
        .map(({ payload_json, ...event }) => ({ ...event, payload: payload_json ? JSON.parse(payload_json) : null })) }));
      db.exec('COMMIT');
    } finally { db.close(); }
    const items = [];
    for (const { task, events } of snapshots) {
      if (account && task.account !== account) throw new Error('Task does not belong to the selected account');
      if (fingerprint && task.fingerprint !== fingerprint) throw new Error('Task content fingerprint changed; reopen the exact task');
      if (revision && reviewRevision(task) !== revision) throw new Error('Task revision changed; reopen the exact task');
      let source = { state: 'current' };
      try { this.frozenAccount(task); await verifyFrozenPackage(task); }
      catch (error) { source = { state: 'stale', reason: error.message }; }
      items.push(reviewItem(task, events, source));
    }
    return { ok: true, items };
  }
  async ingest(input, { dryRun = false, batchId } = {}) {
    const content = await inspectPackage(input);
    batchId = batchIdentifier(batchId);
    if (dryRun) return { ok: true, dryRun: true, package: content };
    const account = getAccount(content.account);
    return this.withDatabase(db => transaction(db, () => {
      const duplicate = db.prepare(`SELECT id, state, batch_id FROM tasks WHERE account_user_id = ? AND kind = ?
        AND fingerprint = ? AND COALESCE(source_note_id,'') = COALESCE(?,'')
        AND state NOT IN ('cancelled','superseded','failed') LIMIT 1`).get(account.userId, content.kind, content.fingerprint, content.sourceNoteId);
      if (duplicate) {
        let assigned = false;
        if (batchId && !duplicate.batch_id && ['draft','queued'].includes(duplicate.state)) {
          db.prepare('UPDATE tasks SET batch_id=?,updated_at=? WHERE id=?').run(batchId,now(),duplicate.id);
          addEvent(db,duplicate.id,'batch_assigned',{ batchId, source: 'duplicate-ingest' });
          assigned = true;
        }
        const existingBatch = assigned ? batchId : duplicate.batch_id;
        const assignmentSkipped = Boolean(batchId && existingBatch !== batchId);
        return { ok: true, duplicate: true, taskId: duplicate.id, state: duplicate.state,
          batchId: existingBatch, ...(batchId ? { batchAssigned: assigned || existingBatch === batchId,
            ...(assignmentSkipped ? { assignmentSkipped: true, existingBatch } : {}) } : {}) };
      }
      const id = `xhs_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
      const timestamp = now();
      db.prepare(`INSERT INTO tasks (
        id,fingerprint,kind,account,account_user_id,browser_profile,source_note_id,replaces_note_id,
        title,body,topics_json,images_json,video_json,cover_json,subtitle_json,manifest_path,package_dir,
        state,scheduled_at,created_at,updated_at,batch_id,media_lineage_json,declarations_json,series_id,episode,content_type
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?,?,?,?,?)`).run(
        id, content.fingerprint, content.kind, content.account, account.userId, account.profile,
        content.sourceNoteId, content.replacesNoteId, content.title, content.body,
        serialize(content.topics), serialize(content.images), serialize(content.video), serialize(content.cover), serialize(content.subtitle),
        content.manifestPath, content.packageDir, content.publishAt, timestamp, timestamp, batchId,
        serialize(content.mediaLineage), serialize(content.declarations), content.seriesId ?? null,
        content.episode == null ? null : String(content.episode), content.contentType ?? null,
      );
      addEvent(db, id, 'ingested', { fingerprint: content.fingerprint, warnings: content.warnings });
      return { ok: true, taskId: id, state: 'draft', batchId, fingerprint: content.fingerprint, warnings: content.warnings };
    }));
  }
  async ingestBatch(inputs, { batchId = `batch_${randomUUID().replaceAll('-', '').slice(0, 20)}`, dryRun = false } = {}) {
    batchIdentifier(batchId);
    if (!Array.isArray(inputs) || !inputs.length) throw new Error('A nonempty package path list is required');
    const results = [];
    for (const input of inputs) {
      try { results.push({ input, ...await this.ingest(input, { batchId, dryRun }) }); }
      catch (error) { results.push({ input, ok: false, error: error.message }); }
    }
    return { ok: results.every(result => result.ok), batchId, results,
      summary: { included: results.filter(result => result.ok && !result.assignmentSkipped).length,
        excluded: results.filter(result => result.assignmentSkipped).length, failed: results.filter(result => !result.ok).length } };
  }
  approveBatch(batchId, options = {}) {
    const tasks = this.plan({ batchId, all: true }).tasks.filter(task => ['draft','queued','failed'].includes(task.state));
    if (!tasks.length) throw new Error('Batch contains no authorizable tasks');
    const results = tasks.map(task => {
      try { return this.approve(task.id, options); } catch (error) { return { ok: false, taskId: task.id, error: error.message }; }
    });
    return { ok: results.every(result => result.ok), batchId, results };
  }
  approve(id, { at, authorization = 'Current operator instruction', fingerprint, revision } = {}) {
    return this.withDatabase(db => transaction(db, () => {
      const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
      if (!task) throw new Error(`Task not found: ${id}`);
      if (!['draft', 'queued', 'failed'].includes(task.state)) throw new Error(`Task is ${task.state}; reconcile an unresolved attempt before authorizing a retry`);
      if (fingerprint && task.fingerprint !== fingerprint) throw new Error('Task content fingerprint changed; reopen the exact task');
      if (revision && reviewRevision(rowToTask(task)) !== revision) throw new Error('Task revision changed; reopen the exact task');
      const scheduledAt = at || task.scheduled_at || now();
      if (!Number.isFinite(Date.parse(scheduledAt))) throw new Error('Schedule must be a valid ISO date');
      const schedule = new Date(scheduledAt).toISOString();
      db.prepare(`UPDATE tasks SET state='queued', scheduled_at=?, approved_at=?, authorization=?, last_error=NULL, last_error_code=NULL,
        last_error_detail_json=NULL, worker_launch_json=NULL, worker_launched_at=NULL, updated_at=? WHERE id=?`)
        .run(schedule, now(), String(authorization), now(), id);
      addEvent(db, id, 'authorized', { authorization: String(authorization), scheduledAt: schedule, previousState: task.state });
      return { ok: true, taskId: id, state: 'queued', scheduledAt: schedule };
    }));
  }
  cancel(id, { reason = 'Cancelled by the current operator' } = {}) {
    return this.withDatabase(db => transaction(db, () => {
      const task = db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
      if (!task) throw new Error(`Task not found: ${id}`);
      if (!['draft','queued','paused','failed'].includes(task.state)) throw new Error(`Task is ${task.state}; unresolved or active writes must be reconciled, not cancelled`);
      db.prepare("UPDATE tasks SET state='cancelled',updated_at=? WHERE id=?").run(now(), id);
      addEvent(db, id, 'cancelled', { reason: String(reason), previousState: task.state });
      return { ok: true, taskId: id, state: 'cancelled' };
    }));
  }
  pause({ account, batchId, reason = 'Paused by the current operator' } = {}) {
    if (!account && !batchId) throw new Error('Pause requires an account or batch ID');
    const selected = this.plan({ account, batchId, all: true }).tasks.filter(task => task.state === 'queued');
    return this.withDatabase(db => transaction(db, () => {
      const timestamp = now();
      const scope = JSON.stringify([account ?? null,batchId ?? null]);
      db.prepare(`INSERT INTO queue_pauses (id,account,batch_id,reason,created_at) VALUES (?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET reason=excluded.reason,created_at=excluded.created_at`)
        .run(scope,account ?? null,batchId ?? null,String(reason),timestamp);
      const result = [];
      for (const task of selected) {
        const changed = db.prepare("UPDATE tasks SET state='paused',paused_at=?,pause_reason=?,updated_at=? WHERE id=? AND state='queued'").run(timestamp, String(reason), timestamp, task.id);
        if (changed.changes) { addEvent(db, task.id, 'paused', { reason: String(reason) }); result.push(task.id); }
      }
      return { ok: true, paused: result, account: account ?? null, batchId: batchId ?? null,
        persistent: true, activeWritesUnaffected: true };
    }));
  }
  resume({ account, batchId } = {}) {
    if (!account && !batchId) throw new Error('Resume requires an account or batch ID');
    const selected = this.plan({ account, batchId, all: true }).tasks.filter(task => task.state === 'paused');
    return this.withDatabase(db => transaction(db, () => {
      db.prepare('DELETE FROM queue_pauses WHERE id=?').run(JSON.stringify([account ?? null,batchId ?? null]));
      const result = [];
      for (const task of selected) {
        if (taskPause(db,task)) continue;
        const changed = db.prepare("UPDATE tasks SET state='queued',paused_at=NULL,pause_reason=NULL,updated_at=? WHERE id=? AND state='paused'").run(now(), task.id);
        if (changed.changes) { addEvent(db, task.id, 'resumed'); result.push(task.id); }
      }
      return { ok: true, resumed: result };
    }));
  }
  phase(id, phase, detail) { return this.withDatabase(db => setTaskPhase(db, id, phase, detail)); }
  recordWorkerLaunch(id, launch) { return this.withDatabase(db => recordWorkerLaunch(db, id, launch)); }
  update(id, state, fields = {}, event = state, payload = {}) {
    return this.withDatabase(db => transaction(db, () => {
      const allowed = new Set(['last_error','last_error_code','last_error_detail_json','platform_note_id','readback_json','verification_json','baseline_ids_json','baseline_note_json','write_started_at','runner_pid','adapter_pid','phase','phase_at']);
      for (const key of Object.keys(fields)) if (!allowed.has(key)) throw new Error(`Unknown task field ${key}`);
      db.prepare(`UPDATE tasks SET state=?, updated_at=?, ${Object.keys(fields).map(key => `${key}=?`).concat('runner_pid=NULL').join(',')} WHERE id=?`)
        .run(state, now(), ...Object.values(fields), id);
      addEvent(db, id, event, payload);
    }));
  }
  async inventory(alias, limit = 1000) {
    const account = getAccount(alias);
    const identity = await verifiedIdentity(account);
    const payload = resultData(
      await readInventory(limit, account.profile, { includeMeta: true }),
      'Inventory',
    );
    const notes = Array.isArray(payload) ? payload : payload?.notes;
    if (!Array.isArray(notes)) throw new Error('Inventory did not return an array');
    return {
      ok: true,
      account: alias,
      identity,
      notes,
      ...(!Array.isArray(payload) && payload
        ? {
            total: payload.total,
            returned: payload.returned,
            complete: payload.complete,
            truncated: payload.truncated,
            requestedLimit: payload.requestedLimit,
          }
        : {}),
    };
  }
  async catalogSync(alias, { limit = 100 } = {}) {
    const inventory = await this.inventory(alias, limit);
    return this.withDatabase(db => importInventory(db, { account: alias, accountUserId: inventory.identity.userId,
      notes: inventory.notes, capturedAt: now() }));
  }
  catalog(options = {}) { return this.withReadDatabase(db => catalogNotes(db, options)); }
  catalogReceipts(options = {}) { return this.withReadDatabase(db => catalogReceipts(db, options)); }
  series(options = {}) { return this.withReadDatabase(db => seriesOverview(db, options), { ok: true, series: [] }); }
  inspection(alias, { limit = 6 } = {}) {
    const account = getAccount(alias);
    return this.withReadDatabase(db => inspectionCandidates(db, { accountUserId: account.userId, limit }),
      { ok: true, notes: [], cursor: null, schedulingCreated: false });
  }
  catalogUpdate(alias, noteId, changes) {
    const account = getAccount(alias);
    return this.withDatabase(db => updateCatalogNote(db, { accountUserId: account.userId, noteId, ...changes }));
  }
  catalogConsolidate(alias, canonicalNoteId, options = {}) {
    const account = getAccount(alias);
    return this.withDatabase(db => consolidateCatalogNotes(db, {
      ...options, account: alias, accountUserId: account.userId, canonicalNoteId,
    }));
  }
  seriesUpsert(alias, options) {
    const account = getAccount(alias);
    return this.withDatabase(db => upsertSeries(db, { ...options, account: alias, accountUserId: account.userId }));
  }
  policy(alias, { policy } = {}) {
    const account = getAccount(alias);
    return policy == null
      ? this.withReadDatabase(db => getAccountPolicy(db, { accountUserId: account.userId }), { ok: true, policy: null, schedulingCreated: false })
      : this.withDatabase(db => setAccountPolicy(db, { account: alias, accountUserId: account.userId, policy }));
  }
  cursor(alias, { watermark, boundaryNoteIds } = {}) {
    const account = getAccount(alias);
    return watermark == null
      ? this.withReadDatabase(db => getInspectionCursor(db, { accountUserId: account.userId }), { ok: true, cursor: null })
      : this.withDatabase(db => setInspectionCursor(db, { account: alias, accountUserId: account.userId, watermark, boundaryNoteIds }));
  }
  async note(alias, id, noteType = 'normal') {
    checkNoteId(id);
    const account = getAccount(alias);
    const identity = await verifiedIdentity(account);
    const note = rowOf(resultData(await readNote(id, account.profile, noteType), 'Note readback'));
    if (note?.noteId !== id) throw new Error('Readback note ID did not match the requested note');
    return { ok: true, account: alias, identity, note };
  }
  frozenAccount(task) {
    const account = getAccount(task.account);
    if (account.userId !== task.account_user_id || account.profile !== task.browser_profile) {
      throw new Error('Account binding changed since ingest');
    }
    return account;
  }
  async findPublished(task, publication = null, attempts = 3) {
    const before = new Set(task.baseline_ids ?? []);
    if (!task.baseline_ids) throw new Error('Pre-submit inventory is missing; supply a verified note ID to reconcile');
    const proposed = publication?.noteId;
    if (proposed && /^[a-f0-9]{24}$/i.test(proposed) && !before.has(proposed)) return proposed;
    for (let attempt = 0; attempt < attempts; attempt++) {
      const rows = resultData(await readInventory(100, task.browser_profile), 'Inventory');
      if (!Array.isArray(rows)) throw new Error('Inventory did not return an array');
      const matches = rows.filter(row => !before.has(String(row.id)) && row.title === task.title);
      if (matches.length === 1) return String(matches[0].id);
      if (matches.length > 1) throw new Error('Multiple new notes match the title; reconcile using the exact note ID');
      if (attempt + 1 < attempts) await new Promise(resolve => setTimeout(resolve, 2000));
    }
    return null;
  }
  async completeReadback(task, noteId, publication = null, { reservation = null, coverEvidence = null } = {}) {
    checkNoteId(noteId);
    const noteType = task.video || task.cover || task.baseline_note?.mediaType === 'video' ? 'video' : 'normal';
    const row = rowOf(resultData(await readNote(noteId, task.browser_profile, noteType, { coverHash: Boolean(coverEvidence) }), 'Note readback'));
    const coverContentEvidence = coverEvidence ? await verifyCoverEvidence(coverEvidence, { ...task, platform_note_id: noteId }, row) : null;
    const verification = compareReadback({ ...task, platform_note_id: noteId }, row, publication, coverContentEvidence);
    const state = verification.matched ? 'verified'
      : task.kind === 'edit' && task.cover ? 'needs_review' : 'submitted';
    const error = verification.matched ? null : 'Submission located; some requested fields still need review';
    if (reservation) {
      this.withDatabase(db => transaction(db, () => {
        const current = db.prepare('SELECT state,phase FROM tasks WHERE id=?').get(task.id);
        if (current?.state !== 'needs_review' || current.phase !== reservation) throw new Error('Manual linkage reservation changed; inspect the current task');
        db.prepare(`UPDATE tasks SET state=?,platform_note_id=?,readback_json=?,verification_json=?,last_error=?,
          phase=?,phase_at=?,updated_at=?,runner_pid=NULL WHERE id=? AND phase=?`)
          .run(state,noteId,serialize(row),serialize(verification),error,verification.matched ? 'readback_verified' : 'readback_needs_review',now(),now(),task.id,reservation);
        addEvent(db,task.id,'platform_readback',{noteId,verification});
      }));
    } else this.update(task.id, state, { platform_note_id: noteId, readback_json: serialize(row), verification_json: serialize(verification), last_error: error,
      phase: verification.matched ? 'readback_verified' : 'readback_needs_review', phase_at: now() },
    'platform_readback', { noteId, verification });
    try {
      this.withDatabase(db => {
        importInventory(db, { account: task.account, accountUserId: task.account_user_id, notes: [row], capturedAt: now(), source: 'readback' });
        updateCatalogNote(db, { accountUserId: task.account_user_id, noteId, latestTaskId: task.id, sourcePath: task.manifest_path,
          ...(task.series_id ? { seriesId: task.series_id } : {}), ...(task.episode ? { episode: task.episode } : {}),
          ...(task.content_type ? { contentType: task.content_type } : {}) });
      });
    } catch (catalogError) {
      this.withDatabase(db => addEvent(db, task.id, 'catalog_update_failed', { error: catalogError.message, publicationUnaffected: true }));
    }
    return { ok: verification.matched, taskId: task.id, state, platformNoteId: noteId, verification, readback: row };
  }
  async execute(id, { dryRun = false, account, batchId, prepareOnly = false, excludeIds = [], preclaimedTask = null } = {}) {
    let task = preclaimedTask;
    if (id && (account || batchId)) {
      const selected = this.show(id).task;
      if ((account && selected.account !== account) || (batchId && selected.batch_id !== batchIdentifier(batchId))) {
        throw new Error('Task does not belong to the selected account or batch');
      }
    }
    if (!id) {
      if (dryRun) task = this.plan({ account, batchId }).tasks.find(candidate => candidate.execution.eligible);
      else {
        const deferredTasks = [];
        const skipped = new Set(excludeIds);
        for (let scanned = 0; scanned < 1000; scanned++) {
          task = this.withDatabase(db => claimNextTask(db, { account, batchId: batchIdentifier(batchId), excludeIds: [...skipped] }));
          if (!task) return { ok: deferredTasks.length === 0, executed: [], deferredTasks,
            message: deferredTasks.length ? 'No further executable task; some due tasks are deferred by another state owner' : 'No executable due queued task' };
          id = task.id;
          const selected = task;
          const result = await this.execute(id, { account, batchId, prepareOnly, preclaimedTask: selected });
          if (result.deferred) {
            deferredTasks.push({ taskId: result.taskId, errorCode: result.errorCode, error: result.error });
            skipped.add(result.taskId);
            continue;
          }
          return { ...result, deferredTasks };
        }
        return { ok: false, executed: [], deferredTasks, scanLimit: 1000,
          message: 'Automatic task selection reached its bounded scan limit' };
      }
      if (!task) return { ok: true, executed: [], message: 'No executable due queued task' };
      id = task.id;
    }
    if (dryRun) {
      task = this.show(id).task;
      if (task.state !== 'queued') throw new Error('Only queued tasks can execute');
      this.frozenAccount(task);
      await verifyFrozenPackage(task);
      return { ok: true, taskId: id, state: task.state, dryRun: true, profile: task.browser_profile,
        argv: ['opencli', ...(task.kind === 'edit' ? editArgs(task) : publishArgs(task))] };
    }
    if (!task || dryRun) task = this.withDatabase(db => claimTask(db, id));
    let writeStarted = false;
    let publication = null;
    let lease = null;
    try {
      const account = this.frozenAccount(task);
      lease = acquireAccountWrite({ accountUserId: task.account_user_id, browserProfile: task.browser_profile,
        home: this.root, taskId: id, attemptId: task.attempt_id });
      this.phase(id, 'preflight');
      await verifyFrozenPackage(task);
      await verifiedIdentity(account);
      let beforeIds = null, beforeNote = null;
      if (task.kind === 'publish') {
        const rows = resultData(await readInventory(100, account.profile), 'Pre-submit inventory');
        if (!Array.isArray(rows)) throw new Error('Pre-submit inventory is not an array');
        beforeIds = rows.map(row => String(row.id));
      } else {
        beforeNote = rowOf(resultData(await readNote(task.source_note_id, account.profile, task.video || task.cover ? 'video' : 'normal'), 'Pre-edit note'));
        if (beforeNote?.noteId !== task.source_note_id) throw new Error('Pre-edit note ID mismatch');
        if (task.images.length && beforeNote.mediaType === 'video') throw new Error('Video notes cannot replace media with images');
        if ((task.video || task.cover) && beforeNote.mediaType !== 'video') throw new Error('Video replacement and custom covers require an existing video note');
        if (task.cover && !task.video && !videoSourceIdentity(beforeNote.video?.src)) {
          throw new Error('The saved video source must be readable before changing its cover');
        }
      }
      task = { ...task, baseline_ids: beforeIds, baseline_note: beforeNote };
      this.withDatabase(db => transaction(db, () => {
        db.prepare('UPDATE tasks SET baseline_ids_json=?,baseline_note_json=?,write_started_at=?,updated_at=? WHERE id=?')
          .run(serialize(beforeIds), serialize(beforeNote), now(), now(), id);
        addEvent(db, id, 'submission_started', { accountUserId: account.userId, mediaType: task.video || task.cover ? 'video' : 'image' });
      }));
      writeStarted = true;
      this.phase(id, 'adapter_started', { prepareOnly });
      const args = task.kind === 'edit' ? editArgs(task, { prepareOnly, keepTab: prepareOnly }) : publishArgs(task, { prepareOnly, keepTab: prepareOnly });
      const response = await runOpencli(args, { profile: account.profile, timeoutMs: task.video || task.cover ? 1_200_000 : 300_000,
        onSpawn: pid => this.withDatabase(db => db.prepare('UPDATE tasks SET adapter_pid=? WHERE id=?').run(pid, id)),
        onProgress: event => {
          if (event?.phase) this.phase(id, event.phase, { ...event.detail, attemptId: task.attempt_id });
        },
      });
      this.withDatabase(db => db.prepare('UPDATE tasks SET adapter_pid=NULL WHERE id=?').run(id));
      publication = rowOf(response.json);
      privateDirectory(path.join(this.root, 'receipts'));
      const receipt = path.join(this.root, 'receipts', `${id}-${task.attempts}.json`);
      await fs.writeFile(receipt, `${JSON.stringify({ taskId: id, createdAt: now(), response }, null, 2)}\n`, { mode: 0o600 });
      this.withDatabase(db => addEvent(db, id, 'adapter_finished', { receipt, exitCode: response.exitCode, timedOut: response.timedOut, publication,
        attemptId: task.attempt_id }));
      if (response.exitCode !== 0) throw adapterError(response, `Adapter exited ${response.exitCode}`);
      if (prepareOnly) {
        if (publication?.status !== 'prepared' || publication?.submitted !== false) throw new Error('Adapter did not confirm a prepared-only composer');
        this.update(id, 'needs_review', { phase: 'prepared', phase_at: now(), write_started_at: null }, 'prepared_for_handoff',
          { receipt, fingerprint: task.fingerprint, publication });
        return { ok: true, taskId: id, state: 'needs_review', phase: 'prepared', submitted: false, receipt,
          recovery: 'Inspect the existing composer before continuing; uploaded media reuse is not assumed.' };
      }
      this.phase(id, 'platform_accepted', { receipt });
      await verifiedIdentity(account);
      const noteId = task.kind === 'edit' ? task.source_note_id : await this.findPublished(task, publication);
      if (!noteId) throw new Error('Submission returned but no unique platform note was located');
      publication = stagedPublication(task, this.show(id).events, publication);
      return { ...await this.completeReadback(task, noteId, publication), receipt };
    } catch (error) {
      if (!writeStarted && ['state_owner_conflict','account_write_unresolved'].includes(error.code)) {
        this.withDatabase(db => transaction(db, () => {
          db.prepare(`UPDATE tasks SET state='queued',attempts=MAX(0,attempts-1),runner_pid=NULL,adapter_pid=NULL,
            last_error=?,last_error_code=?,last_error_detail_json=?,phase='owner_blocked',phase_at=?,updated_at=? WHERE id=?`)
            .run(error.message,error.code,serialize(error.details || error.detail),now(),now(),id);
          addEvent(db,id,'execution_deferred',{ error: error.message, code: error.code, attemptId: task.attempt_id, authorizationPreserved: true });
        }));
        return { ok: false, taskId: id, state: 'queued', deferred: true, error: error.message, errorCode: error.code };
      }
      const state = writeStarted ? 'needs_review' : 'failed';
      this.update(id, state, { last_error: error.message, last_error_code: error.code || null,
        last_error_detail_json: serialize(error.detail || error.details),
        ...(!writeStarted ? { phase: 'preflight_failed', phase_at: now() } : {}) }, state,
      { error: error.message, code: error.code || null, detail: error.detail || error.details || null });
      return { ok: false, taskId: id, state, error: error.message, ...(error.code ? { errorCode: error.code } : {}) };
    } finally {
      if (lease) {
        const current = this.show(id).task;
        lease.release({ unresolved: ['running','submitted','needs_review'].includes(current.state) });
      }
    }
  }
  prepare(id) { return this.execute(id, { prepareOnly: true }); }
  async executeBatch({ account, batchId, limit = 10 } = {}) {
    if (!account && !batchId) throw new Error('Batch execution requires an account or batch ID');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Batch limit must be 1–1000');
    const results = [];
    const deferredIds = [];
    const deferredTasks = [];
    for (let index = 0; index < limit; index++) {
      let result;
      try { result = await this.execute(null, { account, batchId, excludeIds: deferredIds }); }
      catch (error) { results.push({ ok: false, state: 'blocked', error: error.message }); break; }
      for (const deferred of result.deferredTasks || []) {
        if (!deferredIds.includes(deferred.taskId)) deferredIds.push(deferred.taskId);
        deferredTasks.push(deferred);
      }
      if (Array.isArray(result.executed) && result.executed.length === 0) break;
      results.push(result);
      if (result.deferred) {
        deferredIds.push(result.taskId);
        deferredTasks.push({ taskId: result.taskId, errorCode: result.errorCode, error: result.error });
      }
    }
    return { ok: results.every(result => result.ok) && deferredTasks.length === 0, account, batchId, results,
      deferredTasks,
      summary: results.reduce((counts, result) => ({ ...counts, [result.state]: (counts[result.state] || 0) + 1 }), {}) };
  }
  async reconcile(id, { noteId, absent = false, reason } = {}) {
    let { task, events } = this.show(id);
    if (task.state === 'verified') {
      const account = this.frozenAccount(task);
      resolveAccountWrite({ accountUserId: account.userId, browserProfile: account.profile,
        home: this.root, taskId: id, reason: 'Task already has verified same-note readback' });
      return { ok: true, taskId: id, state: 'verified', unchanged: true, verification: task.verification };
    }
    if (!['running', 'submitted', 'needs_review'].includes(task.state)) throw new Error(`Task is ${task.state}; reconciliation applies to unresolved attempts`);
    if (activeProcess(task.runner_pid) || activeProcess(task.adapter_pid)) throw new Error('The task worker or browser writer is still running; wait for its result before reconciling');
    const account = this.frozenAccount(task);
    if (task.state === 'running' && !task.write_started_at) {
      this.update(id, 'failed', { last_error: 'Worker exited before submission began' }, 'preflight_interrupted');
      resolveAccountWrite({ accountUserId: account.userId, browserProfile: account.profile, home: this.root,
        taskId: id, reason: 'Worker ended before any adapter submission was started' });
      return { ok: true, taskId: id, state: 'failed', retryRequiresAuthorization: true };
    }
    await verifiedIdentity(account);
    if (noteId) checkNoteId(noteId);
    const publication = stagedPublication(task, events);
    if (task.kind === 'edit') {
      if (noteId && noteId !== task.source_note_id) throw new Error('Reconcile an edit using its original note ID');
      if (absent) {
        if (!String(reason ?? '').trim()) throw new Error('--absent requires --reason describing the inspected note and composer');
        const current = rowOf(resultData(await readNote(task.source_note_id, task.browser_profile,
          task.video || task.cover || task.baseline_note?.mediaType === 'video' ? 'video' : 'normal'), 'Unchanged edit target'));
        if (!unchangedNote(task.baseline_note, current)) {
          throw new Error('The edit target changed or its baseline is incomplete; inspect the saved note before retrying');
        }
        this.update(id, 'failed', { last_error: `Operator confirmed no edit applied: ${reason}`, readback_json: serialize(current) },
          'unchanged_edit_confirmed', { reason, noteId: task.source_note_id });
        resolveAccountWrite({ accountUserId: account.userId, browserProfile: account.profile, home: this.root, taskId: id, reason });
        return { ok: true, taskId: id, state: 'failed', retryRequiresAuthorization: true };
      }
      noteId = task.source_note_id;
    } else if (!noteId) {
      if (task.platform_note_id) noteId = task.platform_note_id;
      else if (task.baseline_ids) noteId = await this.findPublished(task, publication, 1);
      else {
        const rows = resultData(await readInventory(100, task.browser_profile), 'Missing-baseline reconciliation inventory');
        if (!Array.isArray(rows)) throw new Error('Inventory did not return an array');
        const candidates = rows.filter(row => row.title === task.title).map(row => ({ noteId: String(row.id), title: row.title }));
        if (candidates.length) {
          this.update(id, 'needs_review', { last_error: 'No pre-submit baseline is available and title-matching notes exist; link the exact note ID' },
            'missing_baseline_candidates', { candidates });
          return { ok: false, taskId: id, state: 'needs_review', candidates,
            message: 'A title match cannot establish which note belongs to this attempt; reconcile or link the exact note ID' };
        }
        if (!absent) {
          this.update(id, 'needs_review', { last_error: 'No pre-submit baseline is available; inspect the account and active composer before confirming absence' },
            'missing_baseline_unresolved', { inventoryRead: true, titleMatches: 0 });
          return { ok: false, taskId: id, state: 'needs_review', message: 'Missing baseline requires explicit inspected absence or an exact existing note ID' };
        }
      }
    } else if ((task.baseline_ids ?? []).includes(noteId)) {
      throw new Error('This note existed before the attempted publication');
    }
    if (noteId) {
      if (absent) throw new Error('A candidate note exists; reconcile it before considering another submission');
      const completed = await this.completeReadback(task, noteId, publication);
      if (completed.state === 'verified') resolveAccountWrite({ accountUserId: account.userId, browserProfile: account.profile,
        home: this.root, taskId: id, reason: 'Same-note platform readback matched the frozen task' });
      return completed;
    }
    if (absent) {
      if (!String(reason ?? '').trim()) throw new Error('--absent requires --reason describing confirmation that no note or active composer remains');
      this.update(id, 'failed', { last_error: `Operator confirmed absent: ${reason}` }, 'absence_confirmed', { reason });
      resolveAccountWrite({ accountUserId: account.userId, browserProfile: account.profile, home: this.root, taskId: id, reason });
      return { ok: true, taskId: id, state: 'failed', retryRequiresAuthorization: true };
    }
    this.update(id, 'needs_review', { last_error: 'No matching note observed; this does not prove the submission was absent' }, 'reconciled_unresolved');
    return { ok: false, taskId: id, state: 'needs_review', message: 'No matching note observed; inspect the account and active composer before retrying' };
  }
  handoff(id) {
    const { task, events } = this.show(id);
    const publication = stagedPublication(task, events);
    const stagedCover = task.kind === 'edit' && task.cover && publication?.cover?.preCoverSource;
    return { ok: true, taskId: id, fingerprint: task.fingerprint, revision: reviewRevision(task),
      account: task.account, accountUserId: task.account_user_id, browserProfile: task.browser_profile,
      title: task.title, body: task.body, topics: task.topics, images: task.images,
      video: task.video, cover: task.cover, phase: task.phase, phaseAt: task.phase_at,
      status: task.state, submitted: task.platform_note_id ? true : task.write_started_at ? null : false,
      evidence: { platformNoteId: task.platform_note_id, verification: task.verification,
        phase: task.phase, source: 'local-task', composerReuse: 'requires-live-inspection',
        ...(publication?.cover ? { coverStage: publication.cover } : {}) },
      next: stagedCover
        ? `Inspect the cover on this same note and keep the saved video. Read back with xhs-ops reconcile ${id} before another submission. Without recorded selected-cover source evidence, the cover remains needs_review.`
        : `After completing this exact package manually, link its note ID with xhs-ops link-existing ${id} --note-id NOTE_ID --reason TEXT.` };
  }
  async linkExisting(id, { noteId, reason, coverEvidence = null } = {}) {
    checkNoteId(noteId);
    if (!String(reason || '').trim()) throw new Error('A reason describing the manual publication or existing-note match is required');
    const { task, events } = this.show(id);
    if (['cancelled', 'superseded'].includes(task.state)) throw new Error('A cancelled or superseded task cannot be linked; select the intended active task');
    if (activeProcess(task.runner_pid) || activeProcess(task.adapter_pid)) throw new Error('The task worker or browser writer is still running');
    if (task.kind === 'edit' && task.source_note_id !== noteId) throw new Error('An edit must link the original note ID');
    if (task.platform_note_id && task.platform_note_id !== noteId) throw new Error('This task is already linked to a different platform note');
    if (task.kind === 'publish' && (task.baseline_ids || []).includes(noteId)) throw new Error('This note existed before the attempted publication');
    const account = this.frozenAccount(task);
    const reservation = `manual_link_${randomUUID().replaceAll('-', '')}`;
    this.withDatabase(db => transaction(db, () => {
      const current = rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
      if (reviewRevision(current) !== reviewRevision(task)) throw new Error('Task changed before manual linkage; inspect the current task');
      db.prepare("UPDATE tasks SET state='needs_review',phase=?,phase_at=?,updated_at=? WHERE id=?")
        .run(reservation,now(),now(),id);
      addEvent(db,id,'manual_link_reserved',{ noteId, reservation, previousState: task.state });
    }));
    try {
    await verifiedIdentity(account);
    const publication = stagedPublication(task, events);
    const noteType = task.video || task.cover || task.baseline_note?.mediaType === 'video' ? 'video' : 'normal';
    const row = rowOf(resultData(await readNote(noteId, task.browser_profile, noteType, { coverHash: Boolean(coverEvidence) }), 'Manual publication readback'));
    const verification = compareReadback({ ...task, platform_note_id: noteId }, row, publication);
    if (!verification.checks.noteId || !verification.checks.title || !verification.checks.body || !verification.checks.topics) {
      throw new Error('The specified note does not match this account task’s frozen title, body and native topics');
    }
    this.withDatabase(db => addEvent(db, id, 'manual_publication_claimed', { noteId, reason: String(reason).trim(),
      source: 'operator', verifiedByReadback: false }));
    this.withDatabase(db => {
      const current = db.prepare('SELECT state,phase FROM tasks WHERE id=?').get(id);
      if (current.state !== 'needs_review' || current.phase !== reservation) throw new Error('Manual linkage reservation changed; inspect the current task');
    });
    const completed = await this.completeReadback(task, noteId, publication, { reservation, coverEvidence });
    if (completed.state === 'verified') resolveAccountWrite({ accountUserId: account.userId, browserProfile: account.profile,
      home: this.root, taskId: id, reason: 'Manually identified note matched by same-note platform readback' });
    return { ...completed, source: 'manual-link', publishedByThisCall: false };
    } catch (error) {
      this.withDatabase(db => transaction(db, () => {
        const changed = db.prepare(`UPDATE tasks SET state=?,phase=?,phase_at=?,updated_at=? WHERE id=? AND state='needs_review' AND phase=?`)
          .run(task.state,task.phase ?? null,task.phase_at ?? null,now(),id,reservation);
        if (changed.changes) addEvent(db,id,'manual_link_failed',{ error: error.message, reservation });
      }));
      throw error;
    }
  }
  async coverEvidence(id, { noteId, platformCover } = {}) {
    noteId = checkNoteId(noteId);
    const { task } = this.show(id);
    if (['cancelled', 'superseded'].includes(task.state)) throw new Error('Select an active task for cover evidence');
    if (task.kind === 'edit' && task.source_note_id !== noteId || task.platform_note_id && task.platform_note_id !== noteId) {
      throw new Error('Cover evidence must use the exact original note');
    }
    const account = this.frozenAccount(task);
    await verifiedIdentity(account);
    const row = rowOf(resultData(await readNote(noteId, account.profile, 'video', { coverHash: true }), 'Cover evidence readback'));
    if (!row.coverContent?.sha256 || row.coverContent.bytes <= 0) throw new Error('Bound browser could not produce current cover bytes');
    const verification = compareReadback({ ...task, platform_note_id: noteId }, row);
    if (!verification.checks.noteId || !verification.checks.title || !verification.checks.body || !verification.checks.topics) {
      throw new Error('Cover evidence note does not match the frozen task');
    }
    return createCoverEvidence({ ...task, platform_note_id: noteId }, row, platformCover);
  }
  async supersede(id, { replacementId, reason } = {}) {
    if (!replacementId || replacementId === id || !String(reason || '').trim()) throw new Error('An exact replacement task and supersession reason are required');
    const { task } = this.show(id), { task: replacement } = this.show(replacementId);
    if (!['draft', 'queued', 'paused', 'failed', 'submitted', 'needs_review', 'superseded'].includes(task.state)) throw new Error('Active or verified tasks cannot be superseded');
    if (activeProcess(task.runner_pid) || activeProcess(task.adapter_pid) || activeProcess(replacement.runner_pid) || activeProcess(replacement.adapter_pid)) throw new Error('A task worker or browser writer is still running');
    const noteId = task.platform_note_id || task.source_note_id;
    if (!noteId || replacement.platform_note_id !== noteId || replacement.account_user_id !== task.account_user_id || replacement.browser_profile !== task.browser_profile ||
        replacement.state !== 'verified' || replacement.verification?.matched !== true || replacement.readback?.noteId !== noteId) {
      throw new Error('Supersession requires a verified replacement for the same account and exact note');
    }
    const account = this.frozenAccount(task); this.frozenAccount(replacement);
    await verifiedIdentity(account);
    const noteType = replacement.video || replacement.cover || replacement.baseline_note?.mediaType === 'video' ? 'video' : 'normal';
    const row = rowOf(resultData(await readNote(noteId, account.profile, noteType), 'Replacement note readback'));
    if (!unchangedNote(replacement.readback, row)) throw new Error('The replacement note changed or its saved readback is incomplete; reconcile it first');
    this.withDatabase(db => transaction(db, () => {
      const current = rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(id));
      const successor = rowToTask(db.prepare('SELECT * FROM tasks WHERE id=?').get(replacementId));
      if (reviewRevision(current) !== reviewRevision(task) || reviewRevision(successor) !== reviewRevision(replacement)) throw new Error('Task changed during supersession; inspect the current tasks');
      if (task.state === 'superseded') {
        const previous = db.prepare("SELECT payload_json FROM events WHERE task_id=? AND event='superseded' ORDER BY id DESC LIMIT 1").get(id);
        if (JSON.parse(previous?.payload_json || '{}').replacementId !== replacementId) throw new Error('This task has a different recorded replacement');
      } else {
        db.prepare("UPDATE tasks SET state='superseded',updated_at=? WHERE id=?").run(now(), id);
        addEvent(db, id, 'superseded', { replacementId, replacementFingerprint: replacement.fingerprint, noteId,
          reason: String(reason).trim(), previousState: task.state, verified: false, currentNoteReadAt: now() });
      }
    }));
    resolveAccountWrite({ accountUserId: account.userId, browserProfile: account.profile, home: this.root, taskId: id,
      reason: `Exact note is owned by verified replacement ${replacementId}; original task is superseded, not verified` });
    return { ok: true, taskId: id, state: 'superseded', replacementId, platformNoteId: noteId, verified: false, publishedByThisCall: false };
  }
  async collect(alias, limit = 120, { audit = false } = {}) {
    const account = getAccount(alias);
    await verifiedIdentity(account);
    const rows = resultData(await readMetrics(limit, account.profile), 'Metrics');
    if (!Array.isArray(rows)) throw new Error('Metrics did not return an array');
    if (audit) return { ok: true, account: alias, capturedAt: now(), scanned: rows.length,
      candidates: reviewCandidates(auditRows(rows)), policy: 'Review signals preserve the author’s intent; they do not authorize edits.' };
    const capturedAt = now();
    const current = this.withDatabase(db => rows.map(row => {
      const task = db.prepare(`SELECT id,fingerprint,state FROM tasks WHERE account_user_id=?
        AND (platform_note_id=? OR source_note_id=?) AND (write_started_at IS NOT NULL OR platform_note_id IS NOT NULL)
        ORDER BY updated_at DESC LIMIT 1`)
        .get(account.userId, String(row.id), String(row.id));
      return { row, task };
    }));
    this.withDatabase(db => transaction(db, () => {
      const fields = ['note_id','account','account_user_id','title','published_at','views','likes','collects','comments','shares','avg_view_time','rise_fans','top_source','top_source_pct','top_interest','top_interest_pct','url','captured_at'];
      const statement = db.prepare(`INSERT INTO metrics (${fields.join(',')}) VALUES (${fields.map(() => '?').join(',')}) ON CONFLICT(note_id) DO UPDATE SET ${fields.slice(1).map(key => `${key}=excluded.${key}`).join(',')}`);
      const observations = db.prepare(`INSERT INTO metric_observations (
        note_id,account,account_user_id,title,published_at,views,likes,collects,comments,shares,avg_view_time,rise_fans,
        top_source,top_source_pct,top_interest,top_interest_pct,url,content_revision,captured_at,source
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'collection')`);
      for (const { row, task } of current) {
        const values = [String(row.id),alias,account.userId,String(row.title ?? ''),String(row.published_at ?? row.date ?? ''),
          row.views ?? null,row.likes ?? null,row.collects ?? null,row.comments ?? null,row.shares ?? null,
          row.avg_view_time ?? null,row.rise_fans ?? null,row.top_source ?? null,row.top_source_pct ?? null,
          row.top_interest ?? null,row.top_interest_pct ?? null,row.url ?? null];
        statement.run(...values,capturedAt);
        observations.run(String(row.id),alias,account.userId,String(row.title ?? ''),String(row.published_at ?? row.date ?? ''),
          row.views ?? null,row.likes ?? null,row.collects ?? null,row.comments ?? null,row.shares ?? null,
          row.avg_view_time ?? null,row.rise_fans ?? null,row.top_source ?? null,row.top_source_pct ?? null,
          row.top_interest ?? null,row.top_interest_pct ?? null,row.url ?? null,task?.state === 'verified' ? task.fingerprint : null,capturedAt);
      }
    }));
    return { ok: true, account: alias, capturedAt, notes: rows.length };
  }
  metricsHistory({ account, noteId, limit = 50 } = {}) {
    if (!account && !noteId) throw new Error('Metric history requires an account or note ID');
    if (noteId) checkNoteId(noteId);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('History limit must be 1–1000');
    return this.withReadDatabase(db => {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metric_observations'").get()) {
        return { ok: true, account: account ?? null, noteId: noteId ?? null, observations: [],
          message: 'History is unavailable until the next explicit state migration or metrics collection' };
      }
      const filters = [], params = [];
      if (account) { filters.push('account=?'); params.push(account); }
      if (noteId) { filters.push('note_id=?'); params.push(noteId); }
      const rows = db.prepare(`SELECT * FROM metric_observations WHERE ${filters.join(' AND ')} ORDER BY captured_at DESC LIMIT ?`)
        .all(...params,limit);
      return { ok: true, account: account ?? null, noteId: noteId ?? null, observations: rows,
        coverage: { requested: rows.length, captured: rows.length,
          legacyLatest: rows.filter(row => row.source === 'legacy-latest').length,
          missingIdentity: rows.filter(row => !row.account_user_id).length,
          fields: Object.fromEntries(['views','likes','collects','comments','shares'].map(field => [field,
            { observed: rows.filter(row => row[field] != null).length, missing: rows.filter(row => row[field] == null).length }])) } };
    }, { ok: true, account: account ?? null, noteId: noteId ?? null, observations: [] });
  }
  report({ account, limit = 50 } = {}) {
    return this.withDatabase(db => {
      const filter = account ? ' WHERE account=?' : '';
      const params = account ? [account] : [];
      return { ok: true, generatedAt: now(),
        counts: db.prepare(`SELECT state,COUNT(*) AS count FROM tasks${filter} GROUP BY state`).all(...params),
        tasks: db.prepare(`SELECT id,account,kind,title,state,platform_note_id,last_error FROM tasks${filter} ORDER BY updated_at DESC LIMIT ?`).all(...params,limit),
        metrics: db.prepare(`SELECT * FROM metrics${filter} ORDER BY captured_at DESC LIMIT ?`).all(...params,limit),
        metricObservations: db.prepare(`SELECT * FROM metric_observations${filter} ORDER BY captured_at DESC LIMIT ?`).all(...params,limit) };
    });
  }
}
