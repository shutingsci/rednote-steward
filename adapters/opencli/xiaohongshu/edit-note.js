// RedNote Steward. Derived from the account-ops local OpenCLI adapter.
import { cli, Strategy } from '@jackwener/opencli/registry';
import { CommandExecutionError } from '@jackwener/opencli/errors';
import { applyCover } from './cover-editor.mjs';
import { applyDeclarations, validateDeclarations } from './declarations.mjs';
import { emitProgress } from '../../../src/lib/progress.mjs';
import { videoSourceChanged, videoSourceIdentity } from '../../../src/lib/media.mjs';
import { validateNoteId, validateTitle, validateBody, validateTopics, validateImages, validateVideo, openEditor, readEditor, fillTitle, fillBody, replaceTopics, replaceImages, replaceVideo, normalizeForComparison, sameTopics, submitEdit, editUrl, waitFor } from './editor-helpers.mjs';
import { withOwnedTabCleanup } from './owned-tab.mjs';

cli({
  site: 'xiaohongshu',
  name: 'edit-note',
  description: '批量编辑已发布小红书笔记（文案、真实话题、图片或视频），并回读验收',
  access: 'write',
  example:
    'opencli xiaohongshu edit-note 0123456789abcdef01234567 --title "标题" --content "正文" --topics "旅行,城市漫步"',
  domain: 'creator.xiaohongshu.com',
  strategy: Strategy.COOKIE,
  browser: true,
  navigateBefore: false,
  args: [
    { name: 'note-id', required: true, positional: true, help: '24-character note ID' },
    { name: 'title', default: '', help: 'Replacement title (max 20 characters; required unless --dry-run)' },
    { name: 'content', default: '', help: 'Replacement body without hashtags (required unless --dry-run)' },
    { name: 'topics', default: '', help: 'Comma-separated exact Xiaohongshu topics; empty removes topics when replacing the body' },
    { name: 'images', default: '', help: 'Comma-separated complete image list in display order; empty keeps existing images' },
    { name: 'video', default: '', help: 'Replacement video file; empty keeps existing video' },
    { name: 'cover', default: '', help: 'Custom video cover; may be used alone to preserve the saved video' },
    { name: 'original', help: 'Explicit original declaration: true or false; omitted leaves the current setting' },
    { name: 'ai-declaration', help: 'Explicit AI-generated declaration: true or false; omitted leaves the current setting' },
    { name: 'prepare-only', type: 'bool', default: false, help: 'Prepare the edit without invoking submission' },
    { name: 'upload-timeout', type: 'int', default: 600, help: 'Video upload/processing timeout in seconds' },
    { name: 'cover-timeout', type: 'int', default: 120, help: 'Custom cover preview timeout in seconds' },
    { name: 'dry-run', type: 'bool', default: false, help: 'Open and read the note without changing or submitting it' },
  ],
  columns: ['status', 'noteId', 'title', 'body', 'topicNodes', 'topics', 'images', 'mediaType', 'videoPresent', 'video', 'cover', 'replacement', 'declarations', 'readback', 'submitted', 'snapshot', 'recovery'],
  func: withOwnedTabCleanup(async (page, kwargs) => {
    const noteId = validateNoteId(kwargs['note-id']);
    const title = kwargs['dry-run'] ? String(kwargs.title ?? '').trim() : validateTitle(kwargs.title);
    const content = kwargs['dry-run'] ? String(kwargs.content ?? '').trim() : validateBody(kwargs.content);
    const topics = validateTopics(kwargs.topics);
    const images = validateImages(kwargs.images);
    const video = validateVideo(kwargs.video);
    const cover = kwargs.cover ? validateImages(kwargs.cover) : [];
    const desiredDeclarations = validateDeclarations(kwargs);
    const prepareOnly = kwargs['prepare-only'] === true || kwargs['prepare-only'] === 'true';
    if (cover.length > 1) throw new CommandExecutionError('Choose at most one custom cover');
    if (video && images.length) throw new CommandExecutionError('Choose replacement video or images, not both');
    if (cover.length && images.length) throw new CommandExecutionError('A custom video cover cannot replace images');
    const timeoutSeconds = Number(kwargs['upload-timeout'] ?? 600);
    if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 10 || timeoutSeconds > 3600) {
      throw new CommandExecutionError('upload-timeout must be between 10 and 3600 seconds');
    }
    const coverTimeoutSeconds = Number(kwargs['cover-timeout'] ?? process.env.XHS_OPS_COVER_TIMEOUT ?? 120);
    if (!Number.isInteger(coverTimeoutSeconds) || coverTimeoutSeconds < 10 || coverTimeoutSeconds > 600) {
      throw new CommandExecutionError('cover-timeout must be between 10 and 600 seconds');
    }

    const editsVideo = Boolean(video) || cover.length > 0;
    await openEditor(page, noteId, editsVideo ? 'video' : 'normal');
    emitProgress('selected', { kind: 'edit', noteId });
    const before = await readEditor(page);
    if (!before) throw new CommandExecutionError('The note editor loaded but its fields could not be read');
    if (editsVideo && before.mediaType !== 'video') {
      throw new CommandExecutionError('Video replacement and custom covers require an existing video note');
    }

    if (kwargs['dry-run']) {
      return [{
        status: 'dry-run',
        noteId,
        title: before.title,
        body: before.body,
        topicNodes: before.topics,
        topics: before.topics.map((topic) => topic.name).join(', '),
        images: String(before.imageCount),
        mediaType: before.mediaType, videoPresent: before.videoPresent,
        video: before.video, cover: before.cover,
        readback: 'unchanged',
      }];
    }

    const replacement = video ? await replaceVideo(page, video, timeoutSeconds * 1000) : null;
    let coverSelection = null;
    const savedVideoSource = videoSourceIdentity(before.video?.src);
    if (cover.length && !video) {
      if (!savedVideoSource) throw new CommandExecutionError('The saved video source must be readable before changing its cover');
      const preCoverSource = videoSourceIdentity(before.cover?.url) ? before.cover.url : null;
      if (!preCoverSource) {
        throw new CommandExecutionError(
          `The saved video stage has no readable cover source for note ${noteId}`,
          `Inspect ${editUrl(noteId)} before changing its custom cover.`,
        );
      }
      coverSelection = {
        ...(await applyCover(page, cover[0], { previewTimeoutMs: coverTimeoutSeconds * 1000 })),
        preCoverSource,
      };
    }
    if (before.title !== title) await fillTitle(page, title);
    if (normalizeForComparison(before.body) !== normalizeForComparison(content)) {
      await fillBody(page, content);
    }
    if (!sameTopics(before.topics, topics)) await replaceTopics(page, topics);
    await replaceImages(page, images);
    const declarations = await applyDeclarations(page, desiredDeclarations);

    const prepared = await readEditor(page);
    if (!prepared) throw new CommandExecutionError('Could not verify the edited fields before submission');
    if (prepared.title !== title) {
      throw new CommandExecutionError(`Pre-submit title mismatch: ${JSON.stringify(prepared.title)}`);
    }
    if (normalizeForComparison(prepared.body) !== normalizeForComparison(content)) {
      throw new CommandExecutionError('Pre-submit body mismatch');
    }
    if (!sameTopics(prepared.topics, topics)) {
      throw new CommandExecutionError(
        `Pre-submit topic mismatch: expected ${topics.join(', ')}, got ${prepared.topics.map((topic) => topic.name).join(', ')}`,
      );
    }
    if (images.length && prepared.imageCount !== images.length) {
      throw new CommandExecutionError(
        `Pre-submit image mismatch: expected ${images.length}, got ${prepared.imageCount}`,
      );
    }
    if (video && (!prepared.videoPresent || !prepared.video?.src || prepared.video.src === before.video?.src)) {
      throw new CommandExecutionError('Pre-submit video is absent or not ready');
    }
    const firstStage = video && cover.length ? 'video-and-copy'
      : cover.length ? 'cover-and-copy' : 'single';
    emitProgress('prepared', { kind: 'edit', noteId, mediaType: prepared.mediaType,
      stage: firstStage,
      ...(coverSelection ? { cover: coverSelection, preCoverSource: coverSelection.preCoverSource } : {}),
      ...(video && cover.length ? { pendingStages: ['cover-and-copy'] } : {}),
      ...(coverSelection ? { cover: coverSelection } : {}),
      nativeTopicCount: prepared.topics.length, declarations: declarations.observed,
      composer: { url: prepared.url, observedAt: new Date().toISOString(), persistence: 'not-confirmed' } });
    if (prepareOnly) return [{ status: 'prepared', submitted: false, noteId, title: prepared.title,
      body: prepared.body, topics: prepared.topics, mediaType: prepared.mediaType,
      replacement, cover: coverSelection, declarations, snapshot: prepared,
      recovery: { composerObserved: true, persistedDraftVerified: false,
        ...(video && cover.length ? { coverStage: 'pending-after-video-save', pendingStages: ['cover-and-copy'] } : {}),
        instruction: 'Inspect this same composer and account before continuing; no submission was invoked.' } }];
    const stages = [];
    emitProgress('submit_attempted', { kind: 'edit', noteId, stage: firstStage,
      ...(coverSelection ? { cover: coverSelection } : {}) });
    let submitMethod = await submitEdit(page);
    stages.push({ stage: firstStage, submitMethod });
    emitProgress('platform_accepted', { kind: 'edit', noteId, stage: stages[0].stage,
      confirmation: 'creator-edit-success-page' });

    if (video && cover.length) {
      // The creator UI keeps the custom-cover confirmation disabled until a
      // replacement video has been committed. Reopen the same note after the
      // first save, then apply and commit the cover as a second recoverable
      // stage before the final readback.
      await openEditor(page, noteId, 'video');
      let videoSaved = await readEditor(page);
      if (!videoSaved?.videoPresent || !videoSourceChanged(before.video?.src, videoSaved.video?.src)) {
        throw new CommandExecutionError(
          `The first video edit submission returned for note ${noteId}, but the saved video source did not change`,
          `Inspect ${editUrl(noteId)} and reconcile this same note before another submission.`,
        );
      }
      const preCoverSource = videoSourceIdentity(videoSaved.cover?.url) ? videoSaved.cover.url : null;
      if (!preCoverSource) throw new CommandExecutionError(
        `The saved video stage has no readable cover source for note ${noteId}`,
        `Inspect ${editUrl(noteId)} before preparing its custom cover.`,
      );
      emitProgress('prepared', { kind: 'edit', noteId, stage: 'cover-and-copy',
        preCoverSource, savedVideoSource: videoSaved.video.src,
        cover: { previousSource: preCoverSource, selectionPending: true } });
      coverSelection = {
        ...(await applyCover(page, cover[0], { previewTimeoutMs: coverTimeoutSeconds * 1000 })),
        preCoverSource,
      };
      if (videoSaved.title !== title) await fillTitle(page, title);
      if (normalizeForComparison(videoSaved.body) !== normalizeForComparison(content)) {
        await fillBody(page, content);
      }
      if (!sameTopics(videoSaved.topics, topics)) await replaceTopics(page, topics);
      await applyDeclarations(page, desiredDeclarations);
      const coverPrepared = await readEditor(page);
      if (!coverPrepared || coverPrepared.title !== title
        || normalizeForComparison(coverPrepared.body) !== normalizeForComparison(content)
        || !sameTopics(coverPrepared.topics, topics)) {
        throw new CommandExecutionError(
          `The video stage was saved for note ${noteId}, but the cover-stage fields did not match`,
          `Inspect ${editUrl(noteId)} and reconcile this same note before another submission.`,
        );
      }
      emitProgress('submit_attempted', { kind: 'edit', noteId, stage: 'cover-and-copy',
        cover: coverSelection });
      const coverSubmitMethod = await submitEdit(page);
      stages.push({ stage: 'cover-and-copy', submitMethod: coverSubmitMethod });
      emitProgress('platform_accepted', { kind: 'edit', noteId, stage: 'cover-and-copy',
        confirmation: 'creator-edit-success-page' });
    }

    emitProgress('readback', { noteId });
    await openEditor(page, noteId, editsVideo ? 'video' : 'normal');
    let after = await readEditor(page);
    if (!after) throw new CommandExecutionError('The note editor could not be reopened for readback');
    if (editsVideo) await waitFor(page, async () => {
      after = await readEditor(page);
      return after?.videoPresent && Boolean(after.video?.src);
    }, 15_000, 500, 'saved video metadata');

    const preCoverSource = coverSelection?.preCoverSource ?? coverSelection?.previousSource ?? null;
    const savedCoverSource = videoSourceIdentity(after.cover?.url);
    const coverSourceChanged = cover.length && preCoverSource && savedCoverSource
      ? videoSourceChanged(preCoverSource, after.cover?.url) : !cover.length;
    const verified =
      after.title === title &&
      normalizeForComparison(after.body) === normalizeForComparison(content) &&
      sameTopics(after.topics, topics) &&
      (!images.length || after.imageCount === images.length) &&
      (!video || (after.videoPresent && Boolean(after.video?.src))) &&
      (!cover.length || video || (savedVideoSource && savedVideoSource === videoSourceIdentity(after.video?.src))) &&
      (!cover.length || (coverSourceChanged && savedCoverSource));
    if (!verified) {
      throw new CommandExecutionError(
        `Saved note ${noteId}, but readback did not match the requested title/body/topics/media`,
        `Open ${editUrl(noteId)} and inspect the saved fields.`,
      );
    }

    return [{
      status: 'updated',
      noteId,
      title: after.title,
      body: after.body,
      topicNodes: after.topics,
      topics: after.topics.map((topic) => topic.name).join(', '),
      images: String(after.imageCount),
      mediaType: after.mediaType, videoPresent: after.videoPresent, video: after.video,
      cover: coverSelection ? { ...coverSelection, preCoverSource, savedSource: savedCoverSource,
        savedSourceChanged: Boolean(coverSourceChanged), saveVerified: Boolean(coverSourceChanged),
        identityVerifiedAfterSave: Boolean(savedCoverSource && savedCoverSource === videoSourceIdentity(coverSelection.source)),
        bytesCompared: false } : null,
      declarations,
      replacement: replacement ? { ...replacement, after: after.video,
        savedSourceChanged: videoSourceChanged(before.video?.src, after.video?.src), bytesCompared: false } : null,
      stages,
      readback: video && !videoSourceChanged(before.video?.src, after.video?.src)
        ? 'saved fields match; replacement video version unconfirmed' : `verified observable fields via ${submitMethod}`,
    }];
  }),
});
