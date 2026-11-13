import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import vm from 'node:vm';
import { validatePublishInput, attachFiles, submitOnce, selectPublishSurface, uploadStateScript, publishNote } from '../adapters/opencli/xiaohongshu/steward-publish.js';
import { creatorIdentityScript, readCreatorIdentity } from '../adapters/opencli/xiaohongshu/steward-account.js';
import { sameTopics, replaceVideo, readEditor } from '../adapters/opencli/xiaohongshu/editor-helpers.mjs';
import { videoSourceChanged } from '../src/lib/media.mjs';
import { PROGRESS_PREFIX } from '../src/lib/progress.mjs';
import { assertCreatorLocation } from '../adapters/opencli/xiaohongshu/page-check.mjs';
import { getRegistry } from '@jackwener/opencli/registry';
import '../adapters/opencli/xiaohongshu/inventory.js';
import '../adapters/opencli/xiaohongshu/edit-note.js';

function evaluate(source, context = {}) {
  const result = vm.runInNewContext(`(${source})`, context);
  return typeof result === 'function' ? result() : result;
}

test('page classification uses the observed path and ignores redirect query text', () => {
  assert.equal(assertCreatorLocation('https://creator.xiaohongshu.com/publish/update?id=abc&redirect=/captcha/login').pathname, '/publish/update');
  assert.throws(() => assertCreatorLocation('https://creator.xiaohongshu.com/website-login?redirect=/publish'),
    error => error.code === 'AUTH_REQUIRED');
  assert.throws(() => assertCreatorLocation('https://creator.xiaohongshu.com/website-login/captcha?redirect=/publish'),
    error => error.code === 'VERIFICATION_REQUIRED');
  assert.throws(() => assertCreatorLocation('https://example.invalid/?next=creator.xiaohongshu.com'), /left.*origin/);
});

test('publish rejects mixed media and cover without video before browser use', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-adapters-'));
  try {
    const image = path.join(dir, 'cover.png');
    const video = path.join(dir, 'video.mp4');
    await fs.writeFile(image, 'synthetic image');
    await fs.writeFile(video, 'synthetic video');
    const args = { title: 'A walk', content: 'A quiet morning', topics: '旅行' };
    assert.throws(() => validatePublishInput({ ...args, images: image, video }), /either/);
    assert.throws(() => validatePublishInput({ ...args, images: image, cover: image }), /belongs/);
    assert.throws(() => validatePublishInput({ ...args, video, 'upload-timeout': 0 }), /timeout/);
    const actual = validatePublishInput({ ...args, video, cover: image });
    assert.equal(actual.video, video);
    assert.equal(actual.cover, image);
    assert.equal(actual.timeoutMs, 600_000);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('unknown upload failure never retries attachment', async () => {
  let calls = 0;
  const page = { setFileInput: async () => { calls++; throw new Error('Bridge connection lost'); } };
  await assert.rejects(attachFiles(page, ['/synthetic/video.mp4'], 'input'), /connection lost/);
  assert.equal(calls, 1);
});

test('prepare-only returns the observed composer without invoking submission', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-prepare-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const image = path.join(dir, 'image.png');
  await fs.writeFile(image, 'synthetic image');
  let attached = 0, calls = 0;
  const snapshot = { url: 'https://creator.xiaohongshu.com/publish/publish', title: 'A walk',
    body: 'A quiet morning', topics: [], imageCount: 1, mediaType: 'image', images: [] };
  const responses = [snapshot.url, true, true,
    { pending: false, errors: [], imageCount: 1, videoPresent: false }, 'ready', 'found', snapshot];
  const page = {
    goto: async () => {}, wait: async () => {},
    setFileInput: async () => { attached++; },
    fillText: async (_selector, text) => ({ filled: true, verified: true, actual: text }),
    evaluate: async () => {
      calls++;
      if (!responses.length) throw new Error('Unexpected browser action after prepared snapshot');
      return responses.shift();
    },
  };
  const result = await publishNote(page, { title: snapshot.title, content: snapshot.body, images: image,
    topics: '', 'prepare-only': true });
  assert.equal(result[0].status, 'prepared');
  assert.equal(result[0].submitted, false);
  assert.equal(result[0].recovery.persistedDraftVerified, false);
  assert.equal(result[0].snapshot, snapshot);
  assert.equal(attached, 1);
  assert.equal(calls, 7);
});

test('a throwing submit handler never triggers another method or click', async () => {
  const calls = [];
  const host = {
    offsetParent: {}, getBoundingClientRect: () => ({ width: 120 }),
    hasAttribute: () => false, getAttribute: () => null,
    _onPublish: () => { calls.push('first'); throw new Error('ambiguous submit'); },
    onPublish: () => calls.push('second'),
  };
  const page = { evaluate: source => evaluate(source, { document: { querySelectorAll: selector => selector === 'xhs-publish-btn' ? [host] : [{ click: () => calls.push('button') }] } }) };
  await assert.rejects(submitOnce(page), /ambiguous submit/);
  assert.deepEqual(calls, ['first']);
});

test('native topics need exact names and platform IDs; empty removes all', () => {
  assert.equal(sameTopics([{ id: 'topic-1', name: '旅行' }], ['旅行']), true);
  assert.equal(sameTopics([{ name: '旅行' }], ['旅行']), false);
  assert.equal(sameTopics([{ id: 'topic-1', name: '#旅行' }], ['旅行']), false);
  assert.equal(sameTopics([], []), true);
  assert.equal(sameTopics([{ id: 'topic-1', name: '旅行' }], []), false);
});

test('account identity uses creator response stable ID, never nickname', async () => {
  const identity = await evaluate(creatorIdentityScript(), { fetch: async () => ({ ok: true, json: async () => ({ data: { name: 'Example Creator', user_id: '0123456789abcdef01234567' } }) }) });
  assert.equal(identity.userId, '0123456789abcdef01234567');
  assert.equal(identity.identitySource, 'creator-personal-info');
  await assert.rejects(readCreatorIdentity({ goto: async () => {}, evaluate: async () => ({ logged_in: true, username: 'Example Creator', userId: '' }) }), /stable user ID/);
});

test('creator UI ID is accepted only when linked to the fresh server account', async () => {
  const context = {
    fetch: async () => ({ ok: true, json: async () => ({ data: { name: 'Example Creator', red_num: '123456789' } }) }),
    localStorage: { getItem: () => JSON.stringify({ userName: 'Example Creator', redId: '123456789', userId: '0123456789abcdef01234567' }) },
  };
  const identity = await evaluate(creatorIdentityScript(), context);
  assert.equal(identity.userId, '0123456789abcdef01234567');
  assert.equal(identity.identitySource, 'creator-profile-linked-state');
  context.localStorage.getItem = () => JSON.stringify({ userName: 'Example Creator', redId: '987654321', userId: '0123456789abcdef01234567' });
  const stale = await evaluate(creatorIdentityScript(), context);
  assert.equal(stale.userId, '');
  assert.equal(stale.identitySource, 'unresolved');
});

test('surface selection invokes only the exact requested upload tab', async () => {
  let hasInput = false;
  const clicked = [];
  const tab = { offsetParent: {}, innerText: '上传视频', click() { clicked.push('video'); hasInput = true; } };
  const document = { querySelector: () => hasInput ? {} : null, querySelectorAll: () => [tab] };
  const page = { goto: async () => {}, wait: async () => {}, evaluate: source => evaluate(source, { document, location: { href: 'https://creator.xiaohongshu.com/publish/publish' } }) };
  const selector = await selectPublishSurface(page, 'video');
  assert.match(selector, /video/);
  assert.deepEqual(clicked, ['video']);
});

test('media readiness requires actual video source, not an empty element', () => {
  const document = { querySelector: () => ({ src: '', currentSrc: '', duration: NaN, querySelector: () => null }), querySelectorAll: () => [] };
  const state = evaluate(uploadStateScript(), { document });
  assert.equal(state.videoPresent, false);
  assert.equal(state.videoDuration, null);
});

test('inventory accepts a genuinely empty creator account', async () => {
  const command = getRegistry().get('xiaohongshu/inventory');
  const answers = ['https://creator.xiaohongshu.com/new/note-manager', 0, [], true];
  const page = { goto: async () => {}, wait: async () => {}, evaluate: async () => answers.shift() };
  assert.deepEqual(await command.func(page, { limit: 30 }), []);
});

test('inventory does not mistake a missing page or login for an empty account', async () => {
  const command = getRegistry().get('xiaohongshu/inventory');
  const answers = ['https://creator.xiaohongshu.com/new/note-manager', 0, [], false];
  const page = { goto: async () => {}, wait: async () => {}, evaluate: async () => answers.shift() };
  await assert.rejects(command.func(page, { limit: 30 }), /No creator note cards loaded/);
});

test('inventory reports partial coverage instead of treating the requested limit as the account total', async () => {
  const command = getRegistry().get('xiaohongshu/inventory');
  const first = { id: 'a'.repeat(24), title: 'First', date: '2026-01-01 00:00', cover: '', status: 'unknown' };
  const second = { id: 'b'.repeat(24), title: 'Second', date: '2026-01-02 00:00', cover: '', status: 'unknown' };
  const answers = ['https://creator.xiaohongshu.com/new/note-manager', 808, [first, second]];
  const page = { goto: async () => {}, wait: async () => {}, evaluate: async () => answers.shift() };
  const result = await command.func(page, { limit: 2, 'include-meta': true });
  assert.equal(result.total, 808);
  assert.equal(result.returned, 2);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(result.requestedLimit, 2);
});

test('inventory accepts a limit above the former 600-note ceiling', async () => {
  const command = getRegistry().get('xiaohongshu/inventory');
  const note = { id: 'c'.repeat(24), title: 'Only one', date: '2026-01-01 00:00', cover: '', status: 'unknown' };
  const answers = ['https://creator.xiaohongshu.com/new/note-manager', 1, [note]];
  const page = { goto: async () => {}, wait: async () => {}, evaluate: async () => answers.shift() };
  const result = await command.func(page, { limit: 1000, 'include-meta': true });
  assert.equal(result.total, 1);
  assert.equal(result.complete, true);
  assert.equal(result.truncated, false);
  assert.equal(result.notes.length, 1);
});

test('inventory keeps coverage unknown when total is unavailable and cards stop loading', async () => {
  const command = getRegistry().get('xiaohongshu/inventory');
  const note = { id: 'd'.repeat(24), title: 'Loaded page', date: '', cover: '', status: 'unknown' };
  const answers = ['https://creator.xiaohongshu.com/new/note-manager', null, [note], { found: false }];
  const page = { goto: async () => {}, wait: async () => {}, evaluate: async () => answers.shift() };
  const result = await command.func(page, { limit: 1000, 'include-meta': true });
  assert.equal(result.total, null);
  assert.equal(result.returned, 1);
  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
});

test('inventory preserves metadata for a confirmed empty account and rejects conflicting total', async () => {
  const command = getRegistry().get('xiaohongshu/inventory');
  for (const total of [0, null, 808]) {
    const answers = ['https://creator.xiaohongshu.com/new/note-manager', total, [], { found: false }, true];
    if (total === 0) answers.splice(3, 1);
    const page = { goto: async () => {}, wait: async () => {}, evaluate: async () => answers.shift() };
    if (total === 808) {
      await assert.rejects(command.func(page, { limit: 1000, 'include-meta': true }), /No creator note cards loaded/);
    } else {
      assert.deepEqual(await command.func(page, { limit: 1000, 'include-meta': true }), {
        notes: [], total: 0, returned: 0, complete: true, truncated: false, requestedLimit: 1000,
      });
    }
  }
});

function videoEditor({ inputCount = 1, uploadError = null, image = false, durationAfterUpload = 65.13 } = {}) {
  const title = { offsetParent: {}, value: 'Example' };
  const body = { offsetParent: {}, querySelectorAll: () => [] };
  const video = { currentSrc: 'https://example.invalid/old.mp4', duration: 65.13 };
  const input = { accept: '.mp4', files: [], setAttribute() {} };
  const context = { location: { href: 'https://creator.xiaohongshu.com/publish/update' }, document: {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector.includes('placeholder')) return [title];
      if (selector.includes('tiptap')) return [body];
      if (selector === 'input[type="file"]') return Array(inputCount).fill(input);
      return [];
    },
    querySelector(selector) {
      if (selector === 'video') return image ? null : video;
      if (selector === '.img-container') return image ? {} : null;
      if (selector.includes('tiptap')) return body;
      if (selector.includes('data-steward-video-replacement')) return input;
      return null;
    },
  } };
  let uploads = 0;
  const page = {
    goto: async url => { context.location.href = url; }, wait: async () => {},
    evaluate: source => evaluate(source, context),
    async setFileInput(files) {
      uploads++;
      if (uploadError) throw new Error(uploadError);
      const stat = await fs.stat(files[0]);
      input.files = [{ name: path.basename(files[0]), size: stat.size }];
      video.currentSrc = 'blob:prepared-video';
      video.duration = durationAfterUpload;
    },
  };
  return { page, uploads: () => uploads, context };
}

test('video replacement selects one native input once and retains preparation evidence', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-video-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'clip.mp4');
  await fs.writeFile(video, 'synthetic video');
  const editor = videoEditor();
  const evidence = await replaceVideo(editor.page, video);
  assert.equal(editor.uploads(), 1);
  assert.equal(evidence.selectedFile.name, 'clip.mp4');
  assert.equal(evidence.before.src, 'https://example.invalid/old.mp4');
  assert.equal(evidence.prepared.src, 'blob:prepared-video');
  const ambiguous = videoEditor({ inputCount: 2 });
  await assert.rejects(replaceVideo(ambiguous.page, video), /unavailable/);
  assert.equal(ambiguous.uploads(), 0);
  const lost = videoEditor({ uploadError: 'Connection lost after upload' });
  await assert.rejects(replaceVideo(lost.page, video), /Connection lost/);
  assert.equal(lost.uploads(), 1);
});

test('video replacement does not wait for a transient null browser duration', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-video-duration-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'clip.mp4');
  await fs.writeFile(video, 'synthetic video');
  const editor = videoEditor({ durationAfterUpload: null });
  const evidence = await replaceVideo(editor.page, video);
  assert.equal(evidence.prepared.src, 'blob:prepared-video');
  assert.equal(evidence.prepared.duration, null);
});

test('video readback uses the real cover preview instead of a decorative data image', async () => {
  const title = { offsetParent: {}, value: 'Example' };
  const topic = { getAttribute: () => JSON.stringify({ id: 'topic-1', name: '城市漫步' }), textContent: '#城市漫步' };
  const paragraph = { cloneNode() {
    return { innerText: 'Caption', textContent: 'Caption', querySelectorAll: () => [] };
  } };
  const body = { offsetParent: {}, querySelectorAll(selector) {
    if (selector === ':scope > p') return [paragraph];
    if (selector === 'a.tiptap-topic') return [topic];
    return [];
  } };
  const video = { currentSrc: 'https://example.invalid/video.mp4', duration: NaN };
  const cover = { style: { backgroundImage: 'url("https://example.invalid/cover.jpg")' } };
  const document = {
    querySelectorAll(selector) {
      if (selector.includes('placeholder')) return [title];
      if (selector.includes('tiptap')) return [body];
      if (selector === 'video') return [video];
      if (selector === '.img-container') return [];
      return [];
    },
    querySelector(selector) {
      if (selector === 'video') return video;
      if (selector.includes('cover-plugin-preview')) return cover;
      return null;
    },
  };
  const row = await readEditor({ evaluate: async source => evaluate(source, { document, location: { href: 'https://creator.xiaohongshu.com/publish/update' } }) });
  assert.equal(row.cover.url, 'https://example.invalid/cover.jpg');
  assert.equal(row.video.duration, null);
});

test('video edit rejects an image target before changing its fields or media', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-target-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'clip.mp4'), cover = path.join(dir, 'cover.png');
  await fs.writeFile(video, 'synthetic video');
  await fs.writeFile(cover, 'synthetic image');
  const editor = videoEditor({ image: true });
  const command = getRegistry().get('xiaohongshu/edit-note');
  await assert.rejects(command.func(editor.page, { 'note-id': '000000000000000000000001',
    title: 'Example', content: 'Caption', video }), /existing video note/);
  assert.equal(editor.uploads(), 0);
  assert.match(editor.context.location.href, /noteType=video/);
  const coverOnlyEditor = videoEditor({ image: true });
  await assert.rejects(command.func(coverOnlyEditor.page, { 'note-id': '000000000000000000000001',
    title: 'Example', content: 'Caption', cover }), /existing video note/);
  assert.equal(coverOnlyEditor.uploads(), 0);
  assert.match(coverOnlyEditor.context.location.href, /noteType=video/);
});

test('renewed CDN signatures and blob previews do not prove a changed saved video', () => {
  const original = 'https://example.invalid/video.mp4?signature=old';
  assert.equal(videoSourceChanged(original, 'https://example.invalid/video.mp4?signature=new'), false);
  assert.equal(videoSourceChanged(original, 'https://other-cdn.invalid/video.mp4'), false);
  assert.equal(videoSourceChanged(original, 'blob:prepared-video'), false);
  assert.equal(videoSourceChanged(original, 'https://example.invalid/revised.mp4'), true);
});

// Exercise the registered adapter against an actual DOM-shaped editor. Each
// goto reloads persisted state, so preview changes cannot masquerade as saves.
function stagedVideoEditor({ savedVideo = 'changed', savedCover = 'changed', throwAtSubmit = 0 } = {}) {
  const observed = { opens: [], submissions: 0, videoUploads: 0, coverUploads: 0, coverConfirmations: 0 };
  const attrs = properties => Object.defineProperties({ offsetParent: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    getAttribute(name) { return this.attributes[name] ?? null; },
  }, Object.getOwnPropertyDescriptors(properties));
  let persisted = { title: 'Original', body: 'Original caption',
    video: 'https://example.invalid/original.mp4', cover: 'https://example.invalid/original-cover.jpg' };
  let composer = { ...persisted }, dialogOpen = false, thumbnails = [];
  const location = { href: '' };
  const title = attrs({ get value() { return composer.title; } });
  const paragraph = { cloneNode: () => ({ innerText: composer.body, querySelectorAll: () => [] }) };
  const body = attrs({ querySelectorAll(selector) { return selector === ':scope > p' ? [paragraph] : []; } });
  const video = { get currentSrc() { return composer.video; }, duration: null, querySelector: () => null };
  const preview = attrs({ get style() { return { backgroundImage: `url("${composer.cover}")` }; } });
  const videoInput = attrs({ accept: 'video/mp4', files: [] });
  const coverInput = attrs({ accept: 'image/png', files: [], closest: () => dialog });
  const complete = attrs({ innerText: '完成', disabled: false, click() {
    observed.coverConfirmations++; dialogOpen = false;
    composer.cover = 'https://example.invalid/selected-cover.jpg?preview=1';
  } });
  const entryText = attrs({
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 30 }),
    dispatchEvent: () => {
      dialogOpen = true;
      thumbnails = [{ src: composer.cover, complete: true, naturalWidth: 100 }];
    },
  });
  const coverEntry = attrs({
    querySelector: selector => selector === '.cover-edit-entry-text' ? entryText : null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 30 }),
    dispatchEvent: () => {
      dialogOpen = true;
      thumbnails = [{ src: composer.cover, complete: true, naturalWidth: 100 }];
    },
  });
  const dialog = attrs({ get offsetParent() { return dialogOpen ? {} : null; },
    contains: el => el === coverInput,
    querySelectorAll(selector) {
      if (selector === 'input[type="file"]') return [coverInput];
      if (selector === 'img') return thumbnails;
      if (selector === 'button, [role="button"]') return [complete];
      if (selector === '[class*="loading"], [class*="uploading"]') return [];
      throw new Error(`Unexpected dialog selector ${selector}`);
    },
  });
  const host = attrs({ getBoundingClientRect: () => ({ width: 100, height: 30 }), _onPublish() {
    observed.submissions++;
    if (throwAtSubmit === observed.submissions) throw new Error('Connection lost after submit invocation');
    if (observed.submissions === 1) {
      persisted = { ...composer,
        video: observed.videoUploads === 0 ? persisted.video
          : savedVideo === 'empty' ? '' : savedVideo === 'unchanged'
            ? persisted.video : 'https://example.invalid/revised.mp4',
        cover: observed.videoUploads === 0 ? composer.cover : 'https://example.invalid/video-default-cover.jpg' };
    } else {
      persisted = { ...composer, cover: savedCover === 'unchanged'
        ? persisted.cover : savedCover === 'different' ? 'https://example.invalid/other-cover.jpg'
          : 'https://cdn.example.invalid/platform-transformed-cover.jpg?saved=1' };
    }
    location.href = 'https://creator.xiaohongshu.com/publish/editSuccess';
  } });
  const all = [title, body, preview, videoInput, coverInput, complete, dialog, host, coverEntry];
  const document = {
    body: { innerText: '' },
    querySelectorAll(selector) {
      if (selector.includes('placeholder')) return [title];
      if (selector.includes('tiptap')) return [body];
      if (selector === 'input[type="file"]') return [videoInput];
      if (selector === '.img-container' || selector === '.cover-plugin-preview img') return [];
      if (selector.startsWith('[data-steward-cover-preview]')) return all;
      if (selector === '.cover-plugin-preview .default, [class*="cover-preview"]') return [preview];
      if (selector === '.cover-plugin-preview .cover-edit-entry') return [coverEntry];
      if (selector.startsWith('[role="dialog"]')) return [dialog];
      if (selector === 'xhs-publish-btn') return [host];
      throw new Error(`Unexpected document list selector ${selector}`);
    },
    querySelector(selector) {
      if (selector === 'video') return video;
      if (selector === '.img-container') return null;
      if (selector.includes('tiptap')) return body;
      if (selector.includes('data-steward-video-replacement')) return videoInput;
      if (selector.startsWith('.cover-plugin-preview .default[style')) return preview;
      if (selector === 'input[data-rednote-cover-input="true"]') return coverInput.attributes['data-rednote-cover-input'] ? coverInput : null;
      if (selector === '[data-rednote-cover-dialog="true"]') return dialog.attributes['data-rednote-cover-dialog'] ? dialog : null;
      if (selector === '.cover-plugin-preview .cover-edit-entry') return coverEntry;
      throw new Error(`Unexpected document selector ${selector}`);
    },
  };
  const page = {
    goto: async url => { observed.opens.push(url); location.href = url; composer = { ...persisted }; },
    evaluate: async source => evaluate(source, {
      document,
      location,
      window: {},
      MouseEvent: class {
        constructor(type, options) { this.type = type; this.options = options; }
      },
    }),
    fillText: async (selector, value) => { composer[selector.includes('placeholder') ? 'title' : 'body'] = value;
      return { filled: true, verified: true, actual: value }; },
    hover: async () => {},
    setFileInput: async (files, selector) => {
      const stat = await fs.stat(files[0]);
      const file = { name: path.basename(files[0]), size: stat.size };
      if (selector.includes('video-replacement')) {
        observed.videoUploads++; videoInput.files = [file]; composer.video = 'blob:replacement-video';
      } else {
        observed.coverUploads++; coverInput.files = [file];
        thumbnails = [{ src: 'blob:selected-cover', complete: true, naturalWidth: 100 }];
      }
    },
    wait: async options => {
      if (options?.time === 1) return;
      throw new Error('Unexpected pending editor state');
    },
  };
  return { page, observed };
}

async function stagedEditFixture(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-staged-edit-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const video = path.join(dir, 'clip.mp4'), cover = path.join(dir, 'cover.png');
  await fs.writeFile(video, 'synthetic video'); await fs.writeFile(cover, 'synthetic image');
  const fixture = stagedVideoEditor(options);
  return {
    ...fixture,
    run: extra => getRegistry().get('xiaohongshu/edit-note').func(fixture.page,
      { 'note-id': '000000000000000000000001', title: 'Revised', content: 'Revised caption', video, cover, ...extra }),
    runCoverOnly: extra => getRegistry().get('xiaohongshu/edit-note').func(fixture.page,
      { 'note-id': '000000000000000000000001', title: 'Revised', content: 'Revised caption', cover, ...extra }),
  };
}

test('video and cover save in two stages and verify the same reopened note', async t => {
  const f = await stagedEditFixture(t);
  const [result] = await f.run();
  assert.equal(result.status, 'updated');
  assert.equal(result.video.duration, null);
  assert.equal(result.cover.preCoverSource, 'https://example.invalid/video-default-cover.jpg');
  assert.equal(result.cover.identityVerifiedAfterSave, false);
  assert.equal(result.cover.savedSourceChanged, true);
  assert.equal(result.cover.bytesCompared, false);
  assert.equal(f.observed.submissions, 2);
  assert.equal(f.observed.videoUploads, 1); assert.equal(f.observed.coverUploads, 1);
  assert.equal(f.observed.coverConfirmations, 1); assert.equal(f.observed.opens.length, 3);
  assert.ok(f.observed.opens.every(url => url.includes('id=000000000000000000000001')));
});

test('custom cover timeout is configurable and invalid values fail before browser use', async t => {
  const command = getRegistry().get('xiaohongshu/edit-note');
  const option = command.args.find(arg => arg.name === 'cover-timeout');
  assert.equal(option.default, 120);
  const f = await stagedEditFixture(t);
  await assert.rejects(f.run({ 'cover-timeout': 5 }), /cover-timeout must be between 10 and 600 seconds/);
  assert.equal(f.observed.opens.length, 0);
  assert.equal(f.observed.videoUploads, 0);
  assert.equal(f.observed.coverUploads, 0);
});

test('a custom cover can be repaired without uploading the saved video again', async t => {
  const f = await stagedEditFixture(t);
  const events = [];
  const previousProgress = process.env.XHS_OPS_PROGRESS;
  process.env.XHS_OPS_PROGRESS = '1';
  t.after(() => {
    if (previousProgress === undefined) delete process.env.XHS_OPS_PROGRESS;
    else process.env.XHS_OPS_PROGRESS = previousProgress;
  });
  t.mock.method(process.stderr, 'write', line => {
    if (String(line).startsWith(PROGRESS_PREFIX)) events.push(JSON.parse(String(line).slice(PROGRESS_PREFIX.length)));
    return true;
  });
  const [result] = await f.runCoverOnly();
  assert.equal(result.status, 'updated');
  assert.equal(result.replacement, null);
  assert.equal(result.video.src, 'https://example.invalid/original.mp4');
  assert.equal(result.cover.identityVerifiedAfterSave, true);
  assert.equal(f.observed.submissions, 1);
  assert.equal(f.observed.videoUploads, 0);
  assert.equal(f.observed.coverUploads, 1);
  assert.equal(f.observed.coverConfirmations, 1);
  assert.equal(f.observed.opens.length, 2);
  for (const phase of ['prepared', 'submit_attempted']) {
    const event = events.find(value => value.phase === phase);
    assert.equal(event.detail.stage, 'cover-and-copy');
    assert.equal(event.detail.cover.preCoverSource, 'https://example.invalid/original-cover.jpg');
    assert.equal(event.detail.cover.source, result.cover.source);
    assert.equal(event.detail.cover.confirmationClicked, true);
  }
});

test('cover-only edit rejects mixed image replacement before opening the editor', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'steward-cover-mixed-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const image = path.join(dir, 'image.png');
  await fs.writeFile(image, 'synthetic image');
  const page = { goto: async () => { throw new Error('Unexpected browser navigation'); } };
  await assert.rejects(getRegistry().get('xiaohongshu/edit-note').func(page,
    { 'note-id': '000000000000000000000001', title: 'Revised', content: 'Caption', cover: image, images: image }),
  /custom video cover cannot replace images/);
});

for (const savedVideo of ['unchanged', 'empty']) {
  test(`the cover stage never starts when the first saved video is ${savedVideo}`, async t => {
    const f = await stagedEditFixture(t, { savedVideo });
    await assert.rejects(f.run(), /saved video source did not change/);
    assert.equal(f.observed.submissions, 1); assert.equal(f.observed.videoUploads, 1);
    assert.equal(f.observed.coverUploads, 0); assert.equal(f.observed.coverConfirmations, 0);
  });
}

test('a changed cover preview cannot verify a saved cover that is unchanged', async t => {
  const f = await stagedEditFixture(t, { savedCover: 'unchanged' });
  await assert.rejects(f.run(), /readback did not match/);
  assert.equal(f.observed.submissions, 2); assert.equal(f.observed.videoUploads, 1);
  assert.equal(f.observed.coverUploads, 1); assert.equal(f.observed.opens.length, 3);
});

test('a platform-transformed saved cover is accepted when its resource identity changes', async t => {
  const f = await stagedEditFixture(t, { savedCover: 'different' });
  const [result] = await f.run();
  assert.equal(result.status, 'updated');
  assert.equal(result.cover.preCoverSource, 'https://example.invalid/video-default-cover.jpg');
  assert.equal(result.cover.savedSource, '/other-cover.jpg');
  assert.equal(result.cover.savedSourceChanged, true);
  assert.equal(result.cover.bytesCompared, false);
});

test('prepare-only leaves the cover stage pending and never submits either stage', async t => {
  const f = await stagedEditFixture(t);
  const [result] = await f.run({ 'prepare-only': true });
  assert.equal(result.status, 'prepared'); assert.equal(result.submitted, false);
  assert.equal(result.cover, null);
  assert.equal(result.recovery.coverStage, 'pending-after-video-save');
  assert.deepEqual(result.recovery.pendingStages, ['cover-and-copy']);
  assert.equal(f.observed.submissions, 0); assert.equal(f.observed.videoUploads, 1);
  assert.equal(f.observed.coverUploads, 0); assert.equal(f.observed.opens.length, 1);
});

for (const throwAtSubmit of [1, 2]) {
  test(`an unknown stage ${throwAtSubmit} submission never triggers another submit or video upload`, async t => {
    const f = await stagedEditFixture(t, { throwAtSubmit });
    await assert.rejects(f.run(), /Submit handler threw after invocation/);
    assert.equal(f.observed.submissions, throwAtSubmit); assert.equal(f.observed.videoUploads, 1);
    assert.equal(f.observed.coverUploads, throwAtSubmit - 1);
  });
}
