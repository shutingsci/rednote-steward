import * as path from 'node:path';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { waitFor } from './editor-helpers.mjs';

const entryVisibilityScript = selector => `(() => {
  const entries = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
  const visible = entries.map(entry => Boolean(entry && entry.offsetParent !== null));
  return { count: entries.length, visible };
})()`;

function activateCoverEntryScript() {
  return `(selector => {
    const entry = document.querySelector(selector);
    if (!entry) return { clicked: false, reason: 'missing-entry' };
    const target = entry.querySelector('.cover-edit-entry-text') || entry;
    const rect = target.getBoundingClientRect();
    const options = {
      bubbles: true,
      cancelable: true,
      view: window,
      button: 0,
      clientX: rect.left + Math.max(1, rect.width / 2),
      clientY: rect.top + Math.max(1, rect.height / 2),
    };
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, options));
    }
    return { clicked: true, target: 'cover-edit-entry' };
  })(${JSON.stringify('.cover-plugin-preview .cover-edit-entry')})`;
}

export async function attachFiles(page, files, selector) {
  if (typeof page.setFileInput !== 'function') throw new CommandExecutionError('Update OpenCLI Browser Bridge: local file upload is unavailable');
  // No retry after an ambiguous CDP upload. The controller retains the attempt.
  await page.setFileInput(files, selector);
}

const DIALOG_SELECTOR = '[role="dialog"], .d-modal, [class*="cover-dialog"], [class*="cover-modal"]';
const INPUT_SELECTOR = 'input[data-rednote-cover-input="true"]';
const ACTIVE_DIALOG_SELECTOR = '[data-rednote-cover-dialog="true"]';
const previewSourceScript = `() => {
  const preview = document.querySelector(
    '.cover-plugin-preview .default[style*="background-image"], ' +
    '.cover-plugin-preview [style*="background-image"]'
  );
  const match = String(preview?.style?.backgroundImage || '').match(/^url\\((['"]?)(.*?)\\1\\)$/);
  const image = Array.from(document.querySelectorAll('.cover-plugin-preview img'))
    .find(img => /^(https?:|blob:)/.test(img.currentSrc || img.src || ''));
  return match?.[2] || image?.currentSrc || image?.src || '';
}`;

// The upload command attaches the selected file once. Some creator versions
// remove its input after upload; retain the fresh decoded thumbnail evidence.
function selectionStateScript(filename, previousSources, confirm = false) {
  return `(() => {
    const visible = el => Boolean(el && el.offsetParent !== null);
    const dialog = document.querySelector(${JSON.stringify(ACTIVE_DIALOG_SELECTOR)});
    if (!visible(dialog)) return null;
    const input = document.querySelector(${JSON.stringify(INPUT_SELECTOR)});
    if (input && (!dialog.contains(input) || input.files?.[0]?.name !== ${JSON.stringify(filename)})) return null;
    const thumbnail = Array.from(dialog.querySelectorAll('img')).find(img => {
      const source = img.currentSrc || img.src || '';
      return (img.classList?.contains('uploaded-thumbnail-img') || source.startsWith('blob:')) &&
        source && img.complete && img.naturalWidth > 0 && !${JSON.stringify(previousSources)}.includes(source);
    });
    if (!thumbnail) return null;
    const buttons = Array.from(dialog.querySelectorAll('button, [role="button"]'))
      .filter(el => visible(el) && !el.disabled && !el.hasAttribute('disabled') &&
        el.getAttribute('aria-disabled') !== 'true' && /^(确定|完成|保存)$/.test((el.innerText || '').trim()));
    if (buttons.length !== 1) return null;
    ${confirm ? 'buttons[0].click();' : ''}
    return { filename: ${JSON.stringify(filename)}, thumbnailSource: thumbnail.currentSrc || thumbnail.src,
      fileSelectionEvidence: input ? 'file-input' : 'attachment-acknowledged-and-fresh-thumbnail',
      confirmationClicked: ${confirm} };
  })()`;
}

export async function applyCover(page, cover, { previewTimeoutMs = 120_000 } = {}) {
  const filename = path.basename(cover);
  const before = await page.evaluate(previewSourceScript);
  const previewSelector = await page.evaluate(`() => {
    const visible = el => Boolean(el && el.offsetParent !== null);
    for (const el of document.querySelectorAll('[data-steward-cover-preview], [data-rednote-cover-input], [data-rednote-cover-dialog]')) {
      el.removeAttribute('data-steward-cover-preview');
      el.removeAttribute('data-rednote-cover-input');
      el.removeAttribute('data-rednote-cover-dialog');
    }
    const preview = Array.from(document.querySelectorAll(
      '.cover-plugin-preview .default, [class*="cover-preview"]'
    )).find(visible);
    if (!preview) return '';
    preview.setAttribute('data-steward-cover-preview', 'true');
    return '[data-steward-cover-preview="true"]';
  }`);
  if (!previewSelector) throw new CommandExecutionError('The custom cover preview is unavailable; the cover stage remains unsubmitted');
  // Keep hover and activation on the primary cover. The creator page listens
  // for a Vue pointer sequence; a CDP click can acknowledge the node while the
  // application handler remains dormant.
  const editEntry = await page.evaluate(entryVisibilityScript('.cover-plugin-preview .cover-edit-entry'));
  if (!editEntry || editEntry.count !== 1) {
    throw new CommandExecutionError('The custom cover control is unavailable; the cover stage remains unsubmitted');
  }
  // The selector also matches AI-cover preview cards. Hover the first visible
  // element, which is the primary cover, exactly as the creator UI requires.
  await page.hover(previewSelector, { nth: 0, firstOnMulti: false });
  // The edit entry becomes visible through a short CSS transition after hover.
  // Give the page one scheduler tick before reading it; the hover target is
  // stable and the native click below remains bounded by the CLI timeout.
  await page.wait({ time: 1 });
  const refreshedEntry = await page.evaluate(entryVisibilityScript('.cover-plugin-preview .cover-edit-entry'));
  if (!refreshedEntry || refreshedEntry.count !== 1 || refreshedEntry.visible?.[0] !== true) {
    throw new CommandExecutionError('The custom cover control is unavailable; the cover stage remains unsubmitted');
  }
  const opened = await page.evaluate(activateCoverEntryScript());
  if (!opened?.clicked) throw new CommandExecutionError('The custom cover control is unavailable; the cover stage remains unsubmitted');
  await waitFor(page, async () => Boolean(await page.evaluate(`() => {
    const dialogs = Array.from(document.querySelectorAll(${JSON.stringify(DIALOG_SELECTOR)}))
      .filter(el => el.offsetParent !== null);
    return dialogs.some(dialog => Array.from(dialog.querySelectorAll('input[type="file"]'))
      .some(input => /image|\\.jpg|\\.png/i.test(input.accept)));
  }`)), 10_000, 400, 'custom cover editor');
  const selector = await page.evaluate(`() => {
    const dialogs = Array.from(document.querySelectorAll(${JSON.stringify(DIALOG_SELECTOR)}))
      .filter(el => el.offsetParent !== null);
    // A wrapper and its nested dialog may expose the same file input.
    const inputs = [...new Set(dialogs.flatMap(el => Array.from(el.querySelectorAll('input[type="file"]'))))]
      .filter(el => /image|\\.jpg|\\.png/i.test(el.accept));
    if (inputs.length !== 1) return '';
    const dialog = inputs[0].closest(${JSON.stringify(DIALOG_SELECTOR)});
    if (!dialog || dialog.offsetParent === null) return '';
    inputs[0].setAttribute('data-rednote-cover-input', 'true');
    dialog.setAttribute('data-rednote-cover-dialog', 'true');
    return ${JSON.stringify(INPUT_SELECTOR)};
  }`);
  if (!selector) throw new CommandExecutionError('A unique custom cover file input was not exposed; the cover stage remains unsubmitted');
  const previousSources = await page.evaluate(`() => {
    const dialog = document.querySelector(${JSON.stringify(ACTIVE_DIALOG_SELECTOR)});
    return Array.from(dialog?.querySelectorAll('img') || []).map(img => img.currentSrc || img.src || '');
  }`);
  await attachFiles(page, [cover], selector);
  await waitFor(page, async () => Boolean(await page.evaluate(selectionStateScript(filename, previousSources))),
    previewTimeoutMs, 500, 'custom cover preview');
  const selected = await page.evaluate(selectionStateScript(filename, previousSources, true));
  if (!selected?.confirmationClicked || selected.filename !== filename) {
    throw new CommandExecutionError('Custom cover selection could not be confirmed; the cover stage remains unsubmitted');
  }
  // The creator app may retain an invisible modal node after confirmation.
  // The changed main-cover resource is the observable completion signal.
  let after = before;
  await waitFor(page, async () => {
    after = await page.evaluate(previewSourceScript);
    return Boolean(after && after !== before);
  }, 30_000, 400, 'updated cover preview');
  // Let the cover overlay release pointer/focus despite retaining its DOM
  // node. The composer's following topic picker must receive focus.
  await page.wait({ time: 1 });
  return {
    ...selected,
    previousSource: before,
    source: after,
    selectionVerified: true,
    identityVerifiedAfterSave: false,
    bytesCompared: false,
  };
}
