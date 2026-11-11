import { serializeCaptionMeta, type CaptionMeta } from '../domain/caption';
import type { MediaAttachment, MediaType } from '../domain/viewer';
import { Obscura, type Friend } from '../native/ObscuraModule';
import { fileUri } from '../utils/files';
import { logError } from '../utils/log';
import { refreshMessages, refreshStories } from './store';

export type { MediaAttachment, MediaType };

const inFlightByCache = new WeakMap<Map<string, string>, Map<string, Promise<string>>>();

/**
 * Decrypt the attachment of a pix or story entry to the native cache and remember its `file://`
 * URI by entry id. Concurrent requests against the same `cache` share one in-flight download.
 */
export async function loadAttachmentUri(entryId: string, cache: Map<string, string>): Promise<string> {
  const cached = cache.get(entryId);
  if (cached) return cached;
  let inFlight = inFlightByCache.get(cache);
  if (!inFlight) {
    inFlight = new Map();
    inFlightByCache.set(cache, inFlight);
  }
  const existing = inFlight.get(entryId);
  if (existing) return existing;
  const promise = (async () => {
    try {
      const uri = fileUri(await Obscura.downloadAttachment(entryId));
      cache.set(entryId, uri);
      return uri;
    } finally {
      inFlight.delete(entryId);
    }
  })();
  inFlight.set(entryId, promise);
  return promise;
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
  captionMeta?: CaptionMeta | null;
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
  const result = await Obscura.sendCapture({
    path: resized?.path ?? path,
    mediaType,
    caption,
    captionMeta: captionMeta ? serializeCaptionMeta(captionMeta) : null,
    displayDuration,
    recipientUserIds: recipients.map((f) => f.userId),
    toStory,
  });
  await Promise.all([
    recipients.length > 0 ? refreshMessages() : Promise.resolve(),
    toStory ? refreshStories() : Promise.resolve(),
  ]);

  for (const temp of new Set([path, resized?.path ?? path])) {
    Obscura.deleteFile(temp).catch((e) => logError('cleanup', e));
  }
  const undelivered = new Set(result.undeliveredUserIds);
  return [
    ...recipients.filter((f) => undelivered.has(f.userId)).map((f) => f.username),
    ...(result.storyUndelivered ? ['My story'] : []),
  ];
}
