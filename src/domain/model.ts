import type { Audience } from './audience';
import type { FieldType } from './fields';
import type { MergeRule } from './merge';

/** What the app declares about a model (`src/models/schema.ts`). The kit never reads it. */
export interface ModelDeclaration {
  /** Checked on every local write and every received entry. */
  fields: Readonly<Record<string, FieldType>>;
  merge: MergeRule;
  /** Who a local write reaches. A `conversation` entry is only accepted from a participant. */
  audience: Audience;
  /** Binds an entry to its owner: only user `<id>` may write `<ownerIdPrefix><id>`. */
  ownerIdPrefix?: string;
}
