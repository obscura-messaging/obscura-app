/**
 * The app's models (`docs/DOMAIN_CONTRACT.md`, "Models"). No model has an author field: the author is
 * the authenticated sender, and names come from the friend graph.
 */

import { DirectRoutingUnresolved } from '../domain/audience';
import type { FieldType, FieldValue } from '../domain/fields';
import type { ModelDeclaration } from '../domain/model';

const PROFILE_ID_PREFIX = 'profile_';

export function profileEntryId(userId: string): string {
  return PROFILE_ID_PREFIX + userId;
}

/** Media fields shared by `story` and `pix`, so one viewer renders both. */
const MEDIA_FIELDS = {
  /** `photo` when absent, or `video`. */
  mediaType: 'string?',
  /** A `CaptionMeta` JSON blob (`components/Caption.tsx`). */
  captionMeta: 'string?',
} as const;

// `satisfies` checks the declarations without widening the literal types `ModelData` reads.
export const obscuraSchema = {
  directMessage: {
    fields: { conversationId: 'string', content: 'string' },
    merge: 'APPEND',
    audience: 'conversation',
  },
  story: {
    // A text-only story has no attachment fields.
    fields: { content: 'string', mediaRef: 'string?', contentKey: 'string?', nonce: 'string?', ...MEDIA_FIELDS },
    merge: 'APPEND',
    audience: 'friends',
  },
  profile: {
    fields: { displayName: 'string', bio: 'string?', avatarUrl: 'string?' },
    merge: 'REPLACE',
    audience: 'friends',
    ownerIdPrefix: PROFILE_ID_PREFIX,
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
  },
  seen: {
    // A seen receipt (`domain/seen.ts`); its id names the entry it marks.
    fields: { conversationId: 'string', viewedAt: 'number' },
    merge: 'APPEND',
    audience: 'conversation',
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
