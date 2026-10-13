import { Obscura, type Friend } from '../native/ObscuraModule';
import { conversationId } from '../domain/conversation';
import { logError } from '../utils/log';
import { saveEntry, useStore } from './store';

export type MediaType = 'photo' | 'video';

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
  if (toStory) await saveEntry('story', { content: caption, ...media });

  for (const temp of new Set([path, resized?.path ?? path])) {
    Obscura.deleteFile(temp).catch((e) => logError('cleanup', e));
  }
  return undelivered;
}
