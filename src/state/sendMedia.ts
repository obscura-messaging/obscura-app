import { Obscura, type Friend } from '../native/ObscuraModule';
import { conversationId } from '../domain/conversation';
import { attachmentOf, type Attachment } from '../domain/pix';
import { fileUri } from '../utils/files';
import { logError } from '../utils/log';
import { saveEntry, useStore } from './store';

export { attachmentOf, type Attachment };
export type MediaType = 'photo' | 'video';

/**
 * Decrypt an attachment to the native cache and remember its `file://` URI by `mediaRef`. The
 * native side returns the cached file when it already has one, so repeating this is cheap.
 */
export async function loadAttachmentUri(att: Attachment, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(att.mediaRef);
  if (cached) return cached;
  const path = await Obscura.downloadAttachment(att.mediaRef, att.contentKey, att.nonce);
  const uri = fileUri(path);
  cache.set(att.mediaRef, uri);
  return uri;
}

export function discardCapture(path: string): void {
  Obscura.deleteFile(path).catch((e) => logError('preview.cleanup', e));
}

export function prewarmAudio(): void {
  Obscura.prewarmAudioSession().catch((e) => logError('prewarmAudio', e));
}

export async function createTestCapture(): Promise<string> {
  const img = await Obscura.writeTestImage(100, 100);
  return img.path;
}

export interface Capture {
  path: string;
  mediaType: MediaType;
  caption: string;
  /** A serialized `CaptionMeta`, absent without a caption. */
  captionMeta?: string;
  displayDuration: number;
}

const PHOTO_MAX_DIMENSION = 1080;
const PHOTO_QUALITY = 80;

/**
 * Upload a capture once, send it as a pix to each recipient and optionally post it as a story.
 * Resolves the usernames it could not reach; their pix are stored and retried by the outbox. Temp
 * files are deleted only once everything is stored, so a failure can be retried without reshooting.
 */
export async function sendCapture(capture: Capture, recipients: readonly Friend[], toStory: boolean): Promise<string[]> {
  const { path, mediaType, caption, captionMeta, displayDuration } = capture;
  // Photos are resized natively; video is uploaded as recorded.
  const resized = mediaType === 'photo'
    ? await Obscura.resizeImage(path, PHOTO_MAX_DIMENSION, PHOTO_QUALITY).catch((e) => { logError('resize', e); return null; })
    : null;
  const attachment = await Obscura.uploadAttachment(resized?.path ?? path);
  const media = { mediaRef: attachment.id, contentKey: attachment.contentKey, nonce: attachment.nonce, mediaType, captionMeta };

  const { myUserId } = useStore.getState();
  const undelivered: string[] = [];
  for (const friend of recipients) {
    try {
      await saveEntry('pix', { conversationId: conversationId(myUserId, friend.userId), ...media, caption, displayDuration });
    } catch (e) {
      undelivered.push(friend.username);
      logError('send.pix:' + friend.username, e);
    }
  }
  if (toStory) {
    try {
      await saveEntry('story', { content: caption, ...media });
    } catch (e) {
      undelivered.push('My story');
      logError('send.story', e);
    }
  }

  for (const temp of new Set([path, resized?.path ?? path])) {
    Obscura.deleteFile(temp).catch((e) => logError('cleanup', e));
  }
  return undelivered;
}
