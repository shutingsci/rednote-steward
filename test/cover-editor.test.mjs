import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import * as path from 'node:path';
import { applyCover } from '../adapters/opencli/xiaohongshu/cover-editor.mjs';

function coverPage(options = {}) {
  const observed = { uploads: 0, confirmations: 0, outsideClicks: 0, hovered: false, entryActivations: 0 };
  let opened = false;
  let closed = false;
  let inputRemoved = false;
  let images = [{ src: 'https://example.invalid/old-thumbnail.jpg', complete: true, naturalWidth: 100 }];
  const node = properties => Object.defineProperties({
    offsetParent: {},
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    removeAttribute(name) { delete this.attributes[name]; },
    hasAttribute(name) { return Object.hasOwn(this.attributes, name); },
    getAttribute(name) { return this.attributes[name] ?? null; },
  }, Object.getOwnPropertyDescriptors(properties));
  const preview = node({ style: { backgroundImage: 'url("https://example.invalid/before.jpg?token=old")' } });
  const outside = node({ innerText: '保存', click() { observed.outsideClicks++; } });
  const loading = node({});
  const input = node({ accept: 'image/png,image/jpeg', files: [], closest: () => dialog });
  const button = node({ innerText: '完成', disabled: Boolean(options.disabled), click() {
    observed.confirmations++;
    preview.style.backgroundImage = options.unquoted
      ? 'url(https://example.invalid/selected.jpg?token=new)'
      : 'url("https://example.invalid/selected.jpg?token=new")';
  } });
  if (options.ariaDisabled) button.attributes['aria-disabled'] = 'true';
  const entryText = node({
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 30 }),
    dispatchEvent: () => {
      observed.entryActivations++;
      opened = true;
    },
  });
  const entry = node({
    querySelector: selector => selector === '.cover-edit-entry-text' ? entryText : null,
    getBoundingClientRect: () => ({ left: 10, top: 20, width: 80, height: 30 }),
    dispatchEvent: () => {
      observed.entryActivations++;
      opened = true;
    },
  });
  const dialog = node({
    get offsetParent() { return opened && !closed ? {} : null; },
    contains: el => !inputRemoved && el === input,
    querySelectorAll(selector) {
      if (selector === 'input[type="file"]') return inputRemoved ? [] : [input];
      if (selector === 'img') return images;
      if (selector === '[class*="loading"], [class*="uploading"]') return options.loading ? [loading] : [];
      if (selector === 'button, [role="button"]') return [button];
      throw new Error(`Unexpected dialog selector ${selector}`);
    },
  });
  const wrapper = node({
    get offsetParent() { return opened && !closed ? {} : null; },
    querySelectorAll: selector => selector === 'input[type="file"]' ? [input] : [],
  });
  const otherInput = node({ accept: 'image/png', closest: () => otherDialog });
  const otherDialog = node({ querySelectorAll: selector => selector === 'input[type="file"]' ? [otherInput] : [] });
  const all = [preview, input, dialog, wrapper, button, outside];
  const document = {
    querySelector(selector) {
      if (selector.startsWith('.cover-plugin-preview .default[style')) return preview;
      if (selector === 'input[data-rednote-cover-input="true"]') return !inputRemoved && input.attributes['data-rednote-cover-input'] ? input : null;
      if (selector === '[data-rednote-cover-dialog="true"]') return dialog.attributes['data-rednote-cover-dialog'] ? dialog : null;
      if (selector === '.cover-plugin-preview .cover-edit-entry') return entry;
      throw new Error(`Unexpected document selector ${selector}`);
    },
    querySelectorAll(selector) {
      if (selector === '.cover-plugin-preview img') return [{ src: 'data:image/png;base64,decorative' }];
      if (selector.startsWith('[data-steward-cover-preview]')) return all;
      if (selector === '.cover-plugin-preview .default, [class*="cover-preview"]') return [preview];
      if (selector === '.cover-plugin-preview .cover-edit-entry') return [entry];
      if (selector.startsWith('[role="dialog"]')) return options.ambiguous ? [dialog, otherDialog] : [wrapper, dialog];
      // There is a real enabled save button outside the dialog. It must never be used.
      if (selector === 'button, [role="button"]') return [outside, button];
      throw new Error(`Unexpected document selector ${selector}`);
    },
  };
  const page = {
    evaluate: async source => {
      const result = vm.runInNewContext(`(${source})`, {
        document,
        window: {},
        MouseEvent: class {
          constructor(type, options) { this.type = type; this.options = options; }
        },
      });
      return typeof result === 'function' ? result() : result;
    },
    hover: async (selector, options) => {
      assert.equal(selector, '[data-steward-cover-preview="true"]');
      assert.deepEqual(options, { nth: 0, firstOnMulti: false });
      observed.hovered = true;
    },
    setFileInput: async (files, selector) => {
      observed.uploads++;
      assert.equal(selector, 'input[data-rednote-cover-input="true"]');
      assert.equal(files.length, 1);
      input.files = [{ name: options.wrongFilename ? 'another.png' : path.basename(files[0]) }];
      inputRemoved = Boolean(options.removeInputAfterUpload);
      images = [{
        src: options.stale ? 'https://example.invalid/old-thumbnail.jpg' : 'blob:https://example.invalid/new-upload',
        complete: !options.incomplete,
        naturalWidth: options.incomplete ? 0 : 200,
        classList: { contains: name => name === 'uploaded-thumbnail-img' && !options.stale },
      }];
    },
    // A pending state is enough to test rejection without a real 30-second wait.
    wait: async (waitOptions = {}) => {
      if (waitOptions.time === 1) return;
      throw new Error('Cover UI remains pending');
    },
  };
  return { page, observed };
}

test('cover selection uses the active dialog, decodes CSS URLs and defers persisted identity verification', async () => {
  const { page, observed } = coverPage();
  const result = await applyCover(page, '/synthetic/cover.png');
  assert.deepEqual(observed, { uploads: 1, confirmations: 1, outsideClicks: 0, hovered: true, entryActivations: 5 });
  assert.equal(result.filename, 'cover.png');
  assert.equal(result.previousSource, 'https://example.invalid/before.jpg?token=old');
  assert.equal(result.source, 'https://example.invalid/selected.jpg?token=new');
  assert.equal(result.selectionVerified, true);
  assert.equal(result.identityVerifiedAfterSave, false);
  assert.equal(result.bytesCompared, false);
  assert.equal(result.thumbnailSource, 'blob:https://example.invalid/new-upload');
  assert.equal(result.fileSelectionEvidence, 'file-input');
});

test('cover preview also extracts an unquoted CSS URL', async () => {
  const { page } = coverPage({ unquoted: true });
  assert.equal((await applyCover(page, '/synthetic/cover.png')).source, 'https://example.invalid/selected.jpg?token=new');
});

test('cover selection succeeds after the platform removes the replaced file input', async () => {
  const { page, observed } = coverPage({ removeInputAfterUpload: true });
  const result = await applyCover(page, '/synthetic/cover.png');
  assert.equal(observed.uploads, 1);
  assert.equal(observed.confirmations, 1);
  assert.equal(result.thumbnailSource, 'blob:https://example.invalid/new-upload');
  assert.equal(result.fileSelectionEvidence, 'attachment-acknowledged-and-fresh-thumbnail');
});

test('cover confirmation succeeds even when the creator retains a hidden modal node', async () => {
  const { page, observed } = coverPage({ delayedClose: true });
  const result = await applyCover(page, '/synthetic/cover.png');
  assert.equal(observed.uploads, 1);
  assert.equal(observed.confirmations, 1);
  assert.equal(result.selectionVerified, true);
  assert.equal(result.source, 'https://example.invalid/selected.jpg?token=new');
});

for (const [description, options] of [
  ['stale thumbnail', { stale: true }],
  ['wrong local filename', { wrongFilename: true }],
  ['incomplete thumbnail', { incomplete: true }],
  ['disabled confirmation', { disabled: true }],
  ['aria-disabled confirmation', { ariaDisabled: true }],
]) {
  test(`cover selection waits for ${description} and never clicks an outside save button`, async () => {
    const { page, observed } = coverPage(options);
    await assert.rejects(applyCover(page, '/synthetic/cover.png'), /Cover UI remains pending/);
    assert.equal(observed.uploads, 1);
    assert.equal(observed.confirmations, 0);
    assert.equal(observed.outsideClicks, 0);
  });
}

test('two distinct active cover file inputs stop before attachment', async () => {
  const { page, observed } = coverPage({ ambiguous: true });
  await assert.rejects(applyCover(page, '/synthetic/cover.png'), /unique custom cover file input/);
  assert.equal(observed.uploads, 0);
  assert.equal(observed.confirmations, 0);
});
