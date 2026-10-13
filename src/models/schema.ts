/**
 * The app's model declarations and their accessors (`docs/DOMAIN_CONTRACT.md`). The kit never
 * reads them.
 *
 * No model has a sender or author field: a payload-supplied name is attacker-chosen. An entry's
 * author is `Entry.authorUserId`, the authenticated sender, and display names come from the friend
 * graph at render time.
 */

import { DirectRoutingUnresolved, type AudienceConfig } from '../domain/audience';
import type { ModelRules } from '../domain/drain';
import type { FieldType, FieldValue } from '../domain/fields';
import type { MergeRule } from '../domain/merge';

/**
 * A `profile` entry's id is derived from its owner, which is what makes the entry authorizable:
 * only `<userId>` may write `profile_<userId>` (see `drain.ts`). Kept here so the one place that
 * mints the id and the one place that checks it cannot drift.
 */
export const PROFILE_ID_PREFIX = 'profile_';
export function profileEntryId(userId: string): string {
  return PROFILE_ID_PREFIX + userId;
}

/** What one model declares. */
export interface ModelDeclaration {
  /** Enforced on every local write and every received entry (`domain/fields.ts`). */
  fields: Record<string, FieldType>;
  /** How two writes to one entry id reconcile (`domain/merge.ts`). */
  merge: MergeRule;
  /** Who an entry reaches. Omitted means every accepted friend (`domain/audience.ts`). */
  audience?: AudienceConfig;
  /** An entry-id prefix binding an entry to its owner: only `<userId>` may write `<prefix><userId>`. */
  ownerIdPrefix?: string;
}

/** Every model the app declares, by model key. */
export type ModelSchema = Record<string, ModelDeclaration>;

/**
 * `satisfies`, not `:`. The annotation has to CHECK the declarations without erasing the literal
 * key types that `Object.keys(obscuraSchema)` and the screens' model names rely on.
 *
 * Checking is the point: while these values were untyped, a typo'd merge rule passed both typecheck
 * and the whole test suite while silently flipping a model from APPEND to REPLACE.
 */
export const obscuraSchema = {
  directMessage: {
    fields: { conversationId: 'string', content: 'string' },
    merge: 'APPEND',
    // 1:1 — deliver to both conversation participants; never broadcast.
    audience: { kind: 'conversation', field: 'conversationId' },
  },
  story: {
    fields: {
      content: 'string',
      // Attachment fields — present iff the story has a photo (text-only stories
      // omit all three). Same shape as pix so a single viewer can render both.
      mediaRef: 'string?',
      contentKey: 'string?',
      nonce: 'string?',
      // 'photo' (default when absent) | 'video'. Opaque string.
      mediaType: 'string?',
      // Styled-caption blob (JSON: style/x/y/rot/color/font). Opaque string —
      // the shape can evolve without a schema/contract change. See Caption.tsx.
      captionMeta: 'string?',
    },
    merge: 'APPEND',
    // Erased 24 hours after posting (`domain/expiry.ts`).
  },
  profile: {
    fields: { displayName: 'string', bio: 'string?', avatarUrl: 'string?' },
    merge: 'REPLACE',
    // The id binds the entry to its owner: only `<userId>` may write
    // `profile_<userId>`.
    ownerIdPrefix: PROFILE_ID_PREFIX,
  },
  pix: {
    fields: {
      conversationId: 'string',
      mediaRef: 'string',
      contentKey: 'string',
      nonce: 'string',
      caption: 'string?',
      // 'photo' (default when absent) | 'video'. Opaque string.
      mediaType: 'string?',
      // Styled-caption blob (JSON: style/x/y/rot/color/font). Opaque string —
      // the shape can evolve without a schema/contract change. See Caption.tsx.
      captionMeta: 'string?',
      displayDuration: 'number',
    },
    merge: 'APPEND',
    audience: { kind: 'conversation', field: 'conversationId' },
  },
  seen: {
    // A seen receipt for a `directMessage` or `pix` (`domain/seen.ts`). Its id names the entry.
    fields: { conversationId: 'string', viewedAt: 'number' },
    merge: 'APPEND',
    audience: { kind: 'conversation', field: 'conversationId' },
  },
} satisfies ModelSchema;

/**
 * The same declarations, widened so they can be looked up by a model name that is only known at
 * runtime. `obscuraSchema` itself keeps its literal keys and cannot be indexed by a `string`.
 */
const declarations: ModelSchema = obscuraSchema;

export type ModelName = keyof typeof obscuraSchema;

type FieldsOf<M extends ModelName> = (typeof obscuraSchema)[M]['fields'];

/** A model's data, typed from its declared fields. */
export type ModelData<M extends ModelName> = {
  [K in keyof FieldsOf<M>]: FieldsOf<M>[K] extends FieldType ? FieldValue<FieldsOf<M>[K]> : never;
};

/**
 * The audience a model declares.
 *
 * **Throws on a model the schema does not declare**, and that is the point. Before this check, a
 * lookup miss and a deliberate "no audience declared" were indistinguishable — both produced
 * `undefined`, which `resolveAudience` treats as *broadcast to every friend*. So a single-character
 * typo in a model name turned a 1:1 message into a broadcast, silently. An unknown model is a bug in
 * the app, and a bug must not fail open into a wider audience.
 */
export function audienceFor(model: string): AudienceConfig | undefined {
  if (!Object.prototype.hasOwnProperty.call(obscuraSchema, model)) {
    throw new DirectRoutingUnresolved(
      `'${model}' is not declared in schema.ts, so its audience is unknown`,
    );
  }
  return declarations[model].audience;
}

/** The declared fields of `model`. Throws on an undeclared model. */
export function fieldsFor(model: string): Record<string, FieldType> {
  if (!Object.prototype.hasOwnProperty.call(obscuraSchema, model)) {
    throw new Error(`'${model}' is not declared in schema.ts`);
  }
  return declarations[model].fields;
}

/**
 * What the drain needs per model: the merge rule and the authorization rules.
 *
 * The authorization rules are derived from the same declarations the *send* side uses, so the two
 * directions cannot disagree: a model whose audience is a conversation is exactly a model whose
 * inbound entries must name a conversation between this user and the sender.
 */
export function modelRules(): Map<string, ModelRules> {
  const rules = new Map<string, ModelRules>();
  for (const [model, config] of Object.entries(declarations)) {
    rules.set(model, {
      merge: config.merge,
      fields: config.fields,
      conversationField: config.audience?.kind === 'conversation' ? config.audience.field : undefined,
      ownerIdPrefix: config.ownerIdPrefix,
    });
  }
  return rules;
}
