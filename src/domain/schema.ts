/**
 * Executable model declarations, field validation, and expiry rules.
 *
 * Every send, local write, inbox drain, and expiry sweep reads model rules from `MODELS` /
 * `declarationOf`. Undeclared models throw rather than falling through to a default audience.
 */

import { DirectRoutingUnresolved, type Audience } from './audience';
import type { MergeRule } from './merge';

/** A declared field type. `?` marks it optional. */
export type FieldType = 'string' | 'string?' | 'number' | 'number?';

export type FieldValue<T extends FieldType> =
  T extends 'string' ? string : T extends 'string?' ? string | undefined
    : T extends 'number' ? number : number | undefined;

function matches(type: FieldType, value: unknown): boolean {
  if (value === undefined) return type.endsWith('?');
  return type.startsWith('string')
    ? typeof value === 'string'
    : typeof value === 'number' && Number.isFinite(value);
}

/** Fields of `data` that do not match their declared type. Undeclared fields are allowed. */
export function invalidFields(
  fields: Readonly<Record<string, FieldType>>,
  data: Record<string, unknown>,
): string[] {
  return Object.entries(fields)
    .filter(([name, type]) => !matches(type, data[name]))
    .map(([name]) => name);
}

/** Parse a JSON string into a plain object, returning `null` for non-JSON, primitives, null, or arrays. */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A seen entry is erased this long after it was seen. */
export const EXPIRE_AFTER_MS = 15 * 60 * 1000;

/** Nothing ephemeral outlives this: unseen entries, orphan receipts, erased markers. */
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** A story is erased this long after it was posted. */
export const STORY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type ExpiryRule =
  | { readonly kind: 'afterSeen'; readonly afterSeenMs: number; readonly maxAgeMs: number }
  | { readonly kind: 'afterSent'; readonly maxAgeMs: number }
  | { readonly kind: 'withTarget'; readonly maxAgeMs: number }
  | { readonly kind: 'never' };

export interface ModelDeclaration {
  /** Checked on every local write and every received entry. */
  readonly fields: Readonly<Record<string, FieldType>>;
  readonly merge: MergeRule;
  /** Who a local write reaches. A `conversation` entry is only accepted from a participant. */
  readonly audience: Audience;
  /** Binds an entry to its owner: only user `<id>` may write `<ownerIdPrefix><id>`. */
  readonly ownerIdPrefix?: string;
  /** How entries of this model expire locally. */
  readonly expiry: ExpiryRule;
}

const PROFILE_ID_PREFIX = 'profile_';

export function profileEntryId(userId: string): string {
  return PROFILE_ID_PREFIX + userId;
}

/** Media fields shared by `story` and `pix`, so one viewer renders both. */
const MEDIA_FIELDS = {
  /** `photo` when absent, or `video`. */
  mediaType: 'string?',
  /** A `CaptionMeta` JSON blob (`domain/caption.ts`). */
  captionMeta: 'string?',
} as const;

const EPHEMERAL_EXPIRY: ExpiryRule = {
  kind: 'afterSeen',
  afterSeenMs: EXPIRE_AFTER_MS,
  maxAgeMs: MAX_AGE_MS,
};

export const obscuraSchema = {
  directMessage: {
    fields: { conversationId: 'string', content: 'string' },
    merge: 'APPEND',
    audience: 'conversation',
    expiry: EPHEMERAL_EXPIRY,
  },
  story: {
    // A text-only story has no attachment fields.
    fields: { content: 'string', mediaRef: 'string?', contentKey: 'string?', nonce: 'string?', ...MEDIA_FIELDS },
    merge: 'APPEND',
    audience: 'friends',
    expiry: { kind: 'afterSent', maxAgeMs: STORY_MAX_AGE_MS },
  },
  profile: {
    fields: { displayName: 'string', bio: 'string?', avatarUrl: 'string?' },
    merge: 'REPLACE',
    audience: 'friends',
    ownerIdPrefix: PROFILE_ID_PREFIX,
    expiry: { kind: 'never' },
  },
  pix: {
    fields: {
      conversationId: 'string',
      mediaRef: 'string',
      contentKey: 'string',
      nonce: 'string',
      caption: 'string?',
      ...MEDIA_FIELDS,
      /** Seconds on screen; 0 means the viewer's default. */
      displayDuration: 'number',
    },
    merge: 'APPEND',
    audience: 'conversation',
    expiry: EPHEMERAL_EXPIRY,
  },
  seen: {
    // A seen receipt (`domain/expiry.ts`); its id names the entry it marks.
    fields: { conversationId: 'string', viewedAt: 'number' },
    merge: 'APPEND',
    audience: 'conversation',
    expiry: { kind: 'withTarget', maxAgeMs: MAX_AGE_MS },
  },
} satisfies Record<string, ModelDeclaration>;

export type ModelName = keyof typeof obscuraSchema;

type FieldsOf<M extends ModelName> = (typeof obscuraSchema)[M]['fields'];

/** A model's data, typed from its declared fields. */
export type ModelData<M extends ModelName> = {
  [K in keyof FieldsOf<M>]: FieldsOf<M>[K] extends FieldType ? FieldValue<FieldsOf<M>[K]> : never;
};

/** Every declared model, for lookup by a runtime model name. */
export const MODELS: ReadonlyMap<string, ModelDeclaration> = new Map(Object.entries(obscuraSchema));

/**
 * The declaration of `model`. An undeclared model throws rather than falling through to any
 * audience: a typo must not turn into a send.
 */
export function declarationOf(model: string): ModelDeclaration {
  const declaration = MODELS.get(model);
  if (declaration === undefined) {
    throw new DirectRoutingUnresolved(`'${model}' is not declared in schema.ts`);
  }
  return declaration;
}
