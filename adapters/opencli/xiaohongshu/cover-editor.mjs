import * as path from 'node:path';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { waitFor } from './editor-helpers.mjs';

export async function attachFiles(page, files, selector) {
  if (typeof page.setFileInput !== 'function') throw new CommandExecutionError('Update OpenCLI Browser Bridge: local file upload is unavailable');
  // No retry after an ambiguous CDP upload. The controller retains the attempt.
  await page.setFileInput(files, selector);
}

export async function applyCover(page, cover) {
  const before = await page.evaluate(`() => {
    const preview = document.querySelector(
      '.cover-plugin-preview .default[style*="background-image"], ' +
      '.cover-plugin-preview [style*="background-image"]'
    );
    return String(preview?.style?.backgroundImage || '');
  }`);
  const previewSelector = await page.evaluate(`() => {
    const visible = el => Boolean(el && el.offsetParent !== null);
    const preview = Array.from(document.querySelectorAll(
      '.cover-plugin-preview .default, [class*="cover-preview"]'
    )).find(visible);
    if (!preview) return '';
    preview.setAttribute('data-steward-cover-preview', 'true');
    return '[data-steward-cover-preview="true"]';
  }`);
  if (!previewSelector) throw new CommandExecutionError('The custom cover preview is unavailable; the video remains unsubmitted');
  await page.hover(previewSelector);
  const opened = await page.evaluate(`() => {
    const visible = el => Boolean(el && el.offsetParent !== null);
    const target = Array.from(document.querySelectorAll('.cover-plugin-preview .cover-edit-entry'))
      .find(visible);
    if (!target) return false;
    target.click();
    return true;
  }`);
  if (!opened) throw new CommandExecutionError('The custom cover control is unavailable; the video remains unsubmitted');
  await waitFor(page, async () => Boolean(await page.evaluate(`() => {
    const dialogs = Array.from(document.querySelectorAll(
      '[role="dialog"], .d-modal, [class*="cover-dialog"], [class*="cover-modal"]'
    )).filter(el => el.offsetParent !== null);
    return dialogs.some(dialog => Array.from(dialog.querySelectorAll('input[type="file"]'))
      .some(input => /image|\\.jpg|\\.png/i.test(input.accept)));
  }`)), 10_000, 400, 'custom cover editor');
  const selector = await page.evaluate(`() => {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .d-modal, [class*="cover-dialog"], [class*="cover-modal"]')).filter(el => el.offsetParent !== null);
    const inputs = dialogs.flatMap(el => Array.from(el.querySelectorAll('input[type="file"]')))
      .filter(el => /image|\\.jpg|\\.png/i.test(el.accept))
      // PK candidate covers use a separate list input and do not replace the
      // note's main cover. Ignore it when selecting the single main-cover control.
      .filter(el => !el.classList.contains('pk-cover-list-file-input'));
    if (inputs.length !== 1) return '';
    inputs[0].setAttribute('data-rednote-cover-input', 'true');
    return 'input[data-rednote-cover-input="true"]';
  }`);
  if (!selector) throw new CommandExecutionError('A unique custom cover file input was not exposed; the video remains unsubmitted');
  await attachFiles(page, [cover], selector);
  await waitFor(page, async () => Boolean(await page.evaluate(`() => {
    const visible = el => Boolean(el && el.offsetParent !== null);
    const input = document.querySelector('input[data-rednote-cover-input="true"]');
    const dialog = input?.closest('[role="dialog"], .d-modal, [class*="cover-dialog"], [class*="cover-modal"]');
    const thumbnail = Array.from(dialog?.querySelectorAll('.uploaded-thumbnail-img, img[src*="ros-preview"]') || [])
      .find(img => img.currentSrc || img.src);
    const complete = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(el => visible(el) && !el.disabled && /^(确定|完成|保存)$/.test((el.innerText || '').trim()));
    return Boolean(dialog && thumbnail && complete);
  }`)), 30_000, 500, 'custom cover preview');
  const selected = await page.evaluate(`() => {
    const visible = el => Boolean(el && el.offsetParent !== null);
    const button = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(el => visible(el) && !el.disabled && /^(确定|完成|保存)$/.test((el.innerText || '').trim()));
    if (!button) return null;
    button.click(); return { confirmationClicked: true };
  }`);
  if (!selected?.confirmationClicked) throw new CommandExecutionError('Custom cover selection could not be confirmed; the video remains unsubmitted');
  await waitFor(page, async () => Boolean(await page.evaluate(`() => {
    const dialog = document.querySelector('input[data-rednote-cover-input="true"]')?.closest('[role="dialog"], .d-modal, [class*="cover-dialog"], [class*="cover-modal"]');
    return !dialog || dialog.offsetParent === null;
  }`)), 10_000, 400, 'cover confirmation');
  let after = before;
  await waitFor(page, async () => {
    after = await page.evaluate(`() => {
      const preview = document.querySelector(
        '.cover-plugin-preview .default[style*="background-image"], ' +
        '.cover-plugin-preview [style*="background-image"]'
      );
      return String(preview?.style?.backgroundImage || '');
    }`);
    return Boolean(after && after !== before);
  }, 15_000, 400, 'updated cover preview');
  return {
    filename: path.basename(cover),
    confirmationClicked: true,
    previousSource: before,
    source: after,
    identityVerifiedAfterSave: true,
  };
}
