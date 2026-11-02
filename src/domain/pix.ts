/** How a pix looks from this user's side of the conversation. */
export type PixStatus = 'received_new' | 'received_viewed' | 'sent_pending' | 'sent_opened';

export function pixStatus(pix: { authorUserId: string; viewedAt: number | null }, myUserId: string): PixStatus {
  const viewed = pix.viewedAt !== null;
  if (pix.authorUserId === myUserId) return viewed ? 'sent_opened' : 'sent_pending';
  return viewed ? 'received_viewed' : 'received_new';
}

/** Seconds a photo shows when the sender chose no limit (0) or nothing. */
export const DEFAULT_DISPLAY_SECONDS = 5;

export function displayMs(displayDuration: number | undefined): number {
  return (displayDuration || DEFAULT_DISPLAY_SECONDS) * 1000;
}

export interface Attachment {
  readonly mediaRef: string;
  readonly contentKey: string;
  readonly nonce: string;
}

export function attachmentOf(entry: { data: Record<string, unknown> } | undefined): Attachment | null {
  const mediaRef = entry?.data.mediaRef;
  const contentKey = entry?.data.contentKey;
  const nonce = entry?.data.nonce;
  if (typeof mediaRef !== 'string' || typeof contentKey !== 'string' || typeof nonce !== 'string') return null;
  return { mediaRef, contentKey, nonce };
}
