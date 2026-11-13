/**
 * Xiaohongshu published-note editor.
 *
 * Strategy note:
 * - Strategy: UI_SELECTOR
 * - Contract: visible-ui
 * - Auth: existing Chrome session on creator.xiaohongshu.com
 * - Evidence: the edit page exposes title/body/topic/image controls and the
 *   platform's xhs-publish-btn component performs the update.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { emitProgress } from '../../../src/lib/progress.mjs';
import { assertCreatorLocation } from './page-check.mjs';
import {
  ArgumentError,
  CommandExecutionError,
  TimeoutError,
} from '@jackwener/opencli/errors';

const CREATOR_ORIGIN = 'https://creator.xiaohongshu.com';
const EDIT_PATH = '/publish/update';
const SUCCESS_PATH = '/publish/editSuccess';
const TITLE_SELECTOR = 'input[placeholder*="标题"]';
const BODY_SELECTOR = '.tiptap.ProseMirror';
const IMAGE_INPUT_SELECTOR = [
  'input[type="file"][accept*="image"]',
  'input[type="file"][accept*=".jpg"]',
  'input[type="file"][accept*=".jpeg"]',
  'input[type="file"][accept*=".png"]',
  'input[type="file"][accept*=".webp"]',
].join(',');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v']);
const IMAGE_MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const PUBLISH_METHOD_NAMES = ['_onPublish', 'onPublish', '_onSubmit', '_handlePublish'];

function normalizeText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n');
}

function normalizeForComparison(value) {
  return normalizeText(value).replace(/\s+/g, '');
}

function parseList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim().replace(/^#/, ''))
    .filter(Boolean);
}

function validateNoteId(value) {
  const noteId = String(value ?? '').trim();
  if (!/^[a-f0-9]{24}$/i.test(noteId)) {
    throw new ArgumentError('note-id must be the 24-character Xiaohongshu note ID');
  }
  return noteId;
}

function validateTitle(value) {
  const title = String(value ?? '').trim();
  if (!title) throw new ArgumentError('title is required');
  if ([...title].length > 20) {
    throw new ArgumentError(`title is ${[...title].length} characters; maximum is 20`);
  }
  return title;
}

function validateBody(value) {
  const body = String(value ?? '').trim();
  // Existing photo notes can have a title and topics without a prose caption.
  if ([...body].length > 1000) {
    throw new ArgumentError(`content is ${[...body].length} characters; maximum is 1000`);
  }
  return body;
}

function validateTopics(value) {
  const topics = [...new Set(parseList(value))];
  if (topics.length > 10) throw new ArgumentError('at most 10 topics are supported');
  return topics;
}

function validateImages(value) {
  const images = parseList(value).map((item) => path.resolve(item));
  if (images.length > 18) throw new ArgumentError('at most 18 images are supported');
  for (const image of images) {
    if (!fs.existsSync(image)) throw new ArgumentError(`image not found: ${image}`);
    if (!IMAGE_EXTENSIONS.has(path.extname(image).toLowerCase())) {
      throw new ArgumentError(`unsupported image format: ${image}`);
    }
  }
  return images;
}

function validateVideo(value) {
  if (!value) return null;
  const video = path.resolve(String(value));
  if (!fs.existsSync(video) || !fs.statSync(video).isFile() || !fs.statSync(video).size) {
    throw new ArgumentError(`video not found or empty: ${video}`);
  }
  if (!VIDEO_EXTENSIONS.has(path.extname(video).toLowerCase())) {
    throw new ArgumentError(`unsupported video format: ${video}`);
  }
  return video;
}

function editUrl(noteId, noteType = 'normal') {
  return `${CREATOR_ORIGIN}${EDIT_PATH}?id=${encodeURIComponent(noteId)}&noteType=${encodeURIComponent(noteType)}`;
}

async function waitFor(page, predicate, timeoutMs, intervalMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await page.wait({ time: intervalMs / 1000 });
  }
  throw new TimeoutError(label, Math.ceil(timeoutMs / 1000));
}

async function waitForEditor(page) {
  await waitFor(
    page,
    async () =>
      Boolean(await page.evaluate(
        `(titleSelector => {
          const title = Array.from(document.querySelectorAll(titleSelector)).find((el) => el.offsetParent !== null);
          return title ? 'ready' : '';
        })(${JSON.stringify(TITLE_SELECTOR)})`,
      )),
    15000,
    500,
    'Xiaohongshu note editor',
  );
}

async function openEditor(page, noteId, noteType = 'normal') {
  await page.goto(editUrl(noteId, noteType));
  await waitForEditor(page);
  const currentUrl = String(await page.evaluate('location.href'));
  assertCreatorLocation(currentUrl);
  if (!currentUrl.includes(noteId)) {
    throw new CommandExecutionError(
      `The creator center did not open note ${noteId}`,
      'Confirm the note exists, is visible to this account, and the Chrome login session is current.',
    );
  }
}

async function readEditor(page) {
  return await page.evaluate(
    `((titleSelector, bodySelector) => {
      const titleEl = Array.from(document.querySelectorAll(titleSelector)).find((el) => el.offsetParent !== null);
      const bodyEl = Array.from(document.querySelectorAll(bodySelector)).find((el) => el.offsetParent !== null);
      if (!titleEl || !bodyEl) return null;

      const paragraphs = Array.from(bodyEl.querySelectorAll(':scope > p'))
        .map((paragraph) => {
          const copy = paragraph.cloneNode(true);
          copy.querySelectorAll('a.tiptap-topic').forEach((topic) => topic.remove());
          return (copy.innerText || copy.textContent || '').replace(/\u00a0/g, ' ').trim();
        })
        .filter(Boolean);

      const topics = Array.from(bodyEl.querySelectorAll('a.tiptap-topic'))
        .map((topic) => {
          const raw = topic.getAttribute('data-topic');
          if (!raw) return null;
          try {
            const parsed = JSON.parse(raw);
            return { id: parsed.id || '', name: parsed.name || '' };
          } catch {
            return null;
          }
        })
        .filter((topic) => topic && topic.name);

      return {
        url: String(location.href),
        title: String(titleEl.value || titleEl.innerText || titleEl.textContent || ''),
        body: String(paragraphs.join('\\n\\n')),
        topics: topics.map((topic) => ({ id: String(topic.id), name: String(topic.name) })),
        imageCount: Number(document.querySelectorAll('.img-container').length),
        images: Array.from(document.querySelectorAll('.img-container')).map((container, index) => ({
          order: index + 1,
          url: String(container.querySelector('img')?.currentSrc || container.querySelector('img')?.src || ''),
        })),
        videoPresent: Boolean((() => {
          const element = document.querySelector('video');
          return element?.currentSrc || element?.src || element?.querySelector('source')?.src || '';
        })()),
        mediaType: (() => {
          const element = document.querySelector('video');
          if (element?.currentSrc || element?.src || element?.querySelector('source')?.src) return 'video';
          return document.querySelector('.img-container') ? 'image' : 'unknown';
        })(),
        video: (() => {
          const element = document.querySelector('video');
          if (!element) return null;
          return { src: String(element.currentSrc || element.src || element.querySelector('source')?.src || ''),
            duration: Number.isFinite(element.duration) ? element.duration : null };
        })(),
        cover: (() => {
          const preview = document.querySelector(
            '.cover-plugin-preview .default[style*="background-image"], ' +
            '.cover-plugin-preview [style*="background-image"]'
          );
          const match = String(preview?.style?.backgroundImage || '')
            .match(/^url\\(["']?(.*?)["']?\\)$/);
          if (match?.[1]) return { url: match[1] };
          const element = Array.from(document.querySelectorAll('.cover-plugin-preview img'))
            .find(img => !String(img.src || '').startsWith('data:'));
          return element ? { url: String(element.currentSrc || element.src || '') } : null;
        })(),
      };
    })(${JSON.stringify(TITLE_SELECTOR)}, ${JSON.stringify(BODY_SELECTOR)})`,
  );
}

async function fillTitle(page, title) {
  const result = await page.fillText(TITLE_SELECTOR, title);
  if (!result?.filled || !result?.verified || result.actual !== title) {
    throw new CommandExecutionError(
      `Could not set the title (expected ${JSON.stringify(title)}, got ${JSON.stringify(result?.actual ?? '')})`,
    );
  }
}

async function fillBody(page, body) {
  const prepared = await page.evaluate(
    `(selector => {
      const editor = Array.from(document.querySelectorAll(selector)).find((el) => el.offsetParent !== null);
      return editor ? 'found' : '';
    })(${JSON.stringify(BODY_SELECTOR)})`,
  );
  if (!prepared) throw new CommandExecutionError('Could not focus the note body editor');
  const filled = await page.fillText(BODY_SELECTOR, body);
  if (!filled?.filled) {
    throw new CommandExecutionError('The body editor did not accept the replacement text');
  }
  const actual = String(filled.actual ?? '');
  if (normalizeForComparison(actual) !== normalizeForComparison(body)) {

    throw new CommandExecutionError(
      `Could not set the body. Expected ${normalizeForComparison(body).length} characters, got ${normalizeForComparison(actual).length}. `,
    );
  }
}

async function focusBodyEnd(page) {
  const focused = await page.evaluate(
    `(selector => {
      const editor = Array.from(document.querySelectorAll(selector)).find((el) => el.offsetParent !== null);
      if (!editor) return false;
      editor.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      return true;
    })(${JSON.stringify(BODY_SELECTOR)})`,
  );
  if (!focused) throw new CommandExecutionError('Could not focus the end of the note body');
}

async function addTopic(page, topic) {
  await focusBodyEnd(page);
  await page.pressKey('Enter');
  // Let Tiptap commit the new paragraph before opening the React picker.
  // Opening both in the same event loop turn intermittently yields an empty
  // candidate list.
  await page.wait({ time: 0.3 });
  const picker = await page.evaluate(
    `(() => {
      const candidates = Array.from(document.querySelectorAll('button'));
      const target = candidates.find((button) => (button.innerText || '').includes('话题'));
      if (!target) return false;
      target.click();
      return true;
    })()`,
  );
  if (!picker) {
    throw new CommandExecutionError('Could not open the Xiaohongshu topic picker');
  }
  await page.wait({ time: 0.3 });

  if (typeof page.insertText !== 'function') {
    throw new CommandExecutionError('Native text insertion is unavailable in this Browser Bridge version');
  }
  await page.insertText(topic);
  await page.wait({ time: 0.8 });
  let choice = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    choice = await page.evaluate(
      `(wanted => {
        const norm = (value) => String(value || '').replace(/^#/, '').replace(/\\s+/g, '').trim();
        const container = document.querySelector('#creator-editor-topic-container');
        if (!container) return { ok: false, items: [] };
        const items = Array.from(container.querySelectorAll('.item'));
        const labels = items.map((item) => {
          const name = item.querySelector('.name');
          return (name?.textContent || item.textContent || '').trim();
        });
        const index = labels.findIndex((label) => norm(label) === norm(wanted));
        if (index >= 0) items[index].click();
        return { ok: index >= 0, index, selected: index >= 0, items: labels.slice(0, 12) };
      })(${JSON.stringify(topic)})`,
    );
    if (choice?.ok) break;
    await page.wait({ time: 0.5 });
  }
  if (!choice?.ok) {
    throw new CommandExecutionError(
      `Topic "${topic}" was not found exactly. Visible suggestions: ${(choice?.items || []).join(' | ') || 'none'}`,
    );
  }
  await page.wait({ time: 0.6 });
}

async function replaceTopics(page, topics) {
  if (!topics.length) return;
  for (const topic of topics) await addTopic(page, topic);
}

async function replaceImages(page, images) {
  if (!images.length) return;

  const originalCount = Number(await page.evaluate(`document.querySelectorAll('.img-container').length`));
  // The edit page's upload input rejects CDP DOM.setFileInputFiles with
  // "Not allowed", although the same files upload correctly through a native
  // FileList change event. Upload one file per event so large multi-image
  // payloads cannot reset the Browser Bridge connection.
  await page.hover('.img-container', { nth: 0, firstOnMulti: true });
  await page.click('.img-upload-area .entry', { nth: 0, firstOnMulti: true });
  await page.wait({ time: 0.5 });

  for (const [index, filePath] of images.entries()) {
    emitProgress('uploading', { mediaType: 'image', index: index + 1, total: images.length });
    const bytes = fs.readFileSync(filePath);
    const encoded = {
      name: path.basename(filePath),
      mimeType: IMAGE_MIME_TYPES[path.extname(filePath).toLowerCase()],
    };
    // Browser Bridge can close its connection on multi-megabyte evaluate
    // requests. Transfer bounded chunks and reconstruct the exact file bytes
    // in this tab before dispatching the same native FileList event.
    await page.evaluate('window.__opencliXhsUploadParts = []; true');
    const chunkSize = 192 * 1024;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const chunk = bytes.subarray(offset, offset + chunkSize);
      const received = await page.evaluate(
        `(encoded => {
          const binary = atob(encoded);
          const part = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i += 1) part[i] = binary.charCodeAt(i);
          window.__opencliXhsUploadParts.push(part);
          return part.byteLength;
        })(${JSON.stringify(chunk.toString('base64'))})`,
      );
      if (Number(received) !== chunk.length) {
        throw new CommandExecutionError(`Incomplete image transfer: ${encoded.name}`);
      }
    }
    const expectedCount = originalCount + index + 1;
    const upload = await page.evaluate(
      `((image, inputSelector) => {
        const input = Array.from(document.querySelectorAll(inputSelector))
          .find((element) => element.offsetParent !== null) ||
          document.querySelector(inputSelector);
        if (!input) return { ok: false, error: 'No image file input found' };
        const parts = window.__opencliXhsUploadParts;
        if (!Array.isArray(parts)) return { ok: false, error: 'Missing image chunks' };
        const transfer = new DataTransfer();
        const file = new File(parts, image.name, { type: image.mimeType });
        delete window.__opencliXhsUploadParts;
        transfer.items.add(file);
        Object.defineProperty(input, 'files', {
          configurable: true,
          value: transfer.files,
        });
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return { ok: true, count: transfer.files.length, bytes: file.size };
      })(${JSON.stringify(encoded)}, ${JSON.stringify(IMAGE_INPUT_SELECTOR)})`,
    );
    if (!upload?.ok || upload.count !== 1 || upload.bytes !== bytes.length) {
      throw new CommandExecutionError(
        `Image upload did not attach ${path.basename(filePath)}: ${upload?.error ?? 'unknown error'}`,
      );
    }
    emitProgress('processing', { mediaType: 'image', index: index + 1, total: images.length });
    await waitFor(
      page,
      async () =>
        Number(await page.evaluate(`document.querySelectorAll('.img-container').length`)) ===
        expectedCount,
      45000,
      1000,
      `Xiaohongshu image upload ${index + 1}/${images.length}`,
    );
  }
  await waitFor(
    page,
    async () =>
      Number(await page.evaluate(`document.querySelectorAll('.img-container').length`)) ===
      originalCount + images.length,
    45000,
    1000,
    'Xiaohongshu image upload',
  );

  for (let guard = 0; guard < originalCount; guard += 1) {
    await page.hover('.img-container', { nth: 0, firstOnMulti: true });
    await page.click('.img-container .close-btn', { nth: 0, firstOnMulti: true });
    await page.wait({ time: 0.6 });
  }

  const remaining = Number(await page.evaluate(`document.querySelectorAll('.img-container').length`));
  if (remaining !== images.length) {
    throw new CommandExecutionError(
      `Expected ${images.length} replacement images after removing originals; ${remaining} remain`,
    );
  }
}

async function replaceVideo(page, video, timeoutMs = 600000) {
  if (!video) return null;
  const before = await readEditor(page);
  if (!before?.videoPresent) {
    throw new CommandExecutionError('The edit target is not a video note');
  }
  const videoInput = await page.evaluate(`() => {
    const inputs = Array.from(document.querySelectorAll('input[type="file"]'))
      .filter(el => /video|\\.mp4|\\.mov|\\.m4v/i.test(el.accept));
    if (inputs.length !== 1) return '';
    inputs[0].setAttribute('data-steward-video-replacement', 'true');
    return 'input[data-steward-video-replacement="true"]';
  }`);
  if (!videoInput) {
    throw new CommandExecutionError('The video replacement input is unavailable; the note remains unsubmitted');
  }
  if (typeof page.setFileInput !== 'function') {
    throw new CommandExecutionError('Update OpenCLI Browser Bridge: local video upload is unavailable');
  }
  // Exactly one upload attempt. If the bridge loses the result after the
  // file reaches the platform, the controller retains the task as unknown.
  emitProgress('uploading', { mediaType: 'video', replacement: true });
  await page.setFileInput([video], videoInput);
  emitProgress('processing', { mediaType: 'video', replacement: true });
  const selectedFile = await page.evaluate(`(selector => {
    const input = document.querySelector(selector);
    const file = input?.files?.[0];
    return input?.files?.length === 1 && file ? { name: file.name, bytes: file.size } : null;
  })(${JSON.stringify(videoInput)})`);
  if (selectedFile?.name !== path.basename(video) || selectedFile?.bytes !== fs.statSync(video).size) {
    throw new CommandExecutionError('The replacement video selection could not be confirmed; inspect the current composer');
  }
  await waitFor(
    page,
    async () => {
      const state = await readEditor(page);
      const text = String(await page.evaluate('document.body.innerText'));
      return Boolean(
        state?.videoPresent &&
        state.video?.src !== before.video?.src &&
        !/上传失败|上传错误|处理失败|处理错误/.test(text),
      );
    },
    timeoutMs,
    1000,
    'Xiaohongshu video upload and processing',
  );
  const prepared = await readEditor(page);
  return { selectedFile, before: before.video, prepared: prepared.video };
}

async function submitEdit(page) {
  const invoked = await page.evaluate(
    `(methodNames => {
      const visible = (el) => {
        if (!el || el.offsetParent === null) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const hosts = Array.from(document.querySelectorAll('xhs-publish-btn')).filter(visible);
      for (const host of hosts) {
        for (const name of methodNames) {
          if (typeof host[name] !== 'function') continue;
          try {
            host[name]();
            return { ok: true, via: 'component-method', name };
          } catch (error) {
            throw new Error('Submit handler threw after invocation; reconcile the note before another attempt: ' + String(error));
          }
        }
      }
      return { ok: false, hosts: hosts.length };
    })(${JSON.stringify(PUBLISH_METHOD_NAMES)})`,
  );
  if (!invoked?.ok) {
    throw new CommandExecutionError(
      `Could not submit the edit (visible xhs-publish-btn hosts: ${invoked?.hosts ?? 0})`,
    );
  }

  await waitFor(
    page,
    async () => {
      const url = String(await page.evaluate('location.href'));
      return url.includes(SUCCESS_PATH);
    },
    20000,
    500,
    'Xiaohongshu edit confirmation',
  );
  return invoked.name;
}

function sameTopics(actual, expected) {
  if (actual.length !== expected.length) return false;
  return expected.every((topic, index) => actual[index]?.name === topic && Boolean(actual[index]?.id));
}


export { normalizeText, normalizeForComparison, validateNoteId, validateTitle, validateBody, validateTopics, validateImages, validateVideo, editUrl, waitFor, waitForEditor, openEditor, readEditor, fillTitle, fillBody, addTopic, replaceTopics, replaceImages, replaceVideo, submitEdit, sameTopics, IMAGE_INPUT_SELECTOR };
