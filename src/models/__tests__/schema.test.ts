import { audienceFor, modelRules } from '../schema';
import { DirectRoutingUnresolved } from '../../domain/audience';

/**
 * The schema and the two accessors that interpret it (`DOMAIN_CONTRACT.md`, "Models").
 *
 * The declarations used to be an untyped object literal read through a private structural cast per
 * consumer, and a typo'd merge rule passed typecheck AND the whole suite while flipping a model from
 * APPEND to REPLACE. `satisfies ModelSchema` is what catches the typo; these tests catch the half a
 * type cannot — `merge: 'REPLACE'` on `story` is well-typed and wrong.
 *
 * The compile-time half is NOT assertable here: `@ts-expect-error` would be inert, because
 * `isolatedModules` puts ts-jest in transpile-only mode and `tsconfig.json` excludes `__tests__`
 * from `npm run typecheck`. `tsc -p tsconfig.test.json` is the only thing that type-checks this
 * file, and nothing runs it.
 */

describe('what each model means', () => {
  /** Pinned against DOMAIN_CONTRACT's "Models" table, model for model. */
  it('matches the contract table', () => {
    const rules = modelRules();

    expect([...rules.keys()].sort()).toEqual(['directMessage', 'pix', 'profile', 'seen', 'story']);
    expect(rules.get('directMessage')).toMatchObject({
      merge: 'APPEND', conversationField: 'conversationId', ownerIdPrefix: undefined,
    });
    expect(rules.get('story')).toMatchObject({
      merge: 'APPEND', conversationField: undefined, ownerIdPrefix: undefined,
    });
    expect(rules.get('pix')).toMatchObject({
      merge: 'APPEND', conversationField: 'conversationId', ownerIdPrefix: undefined,
    });
    expect(rules.get('seen')).toMatchObject({
      merge: 'APPEND', conversationField: 'conversationId', ownerIdPrefix: undefined,
    });
    expect(rules.get('profile')).toMatchObject({
      merge: 'REPLACE', conversationField: undefined, ownerIdPrefix: 'profile_',
    });
  });

  /**
   * The send and receive rules come from one declaration, so a conversation-scoped audience and a
   * conversation-scoped authorization cannot drift apart.
   */
  it('derives the drain\'s conversation rule from the same field the audience names', () => {
    for (const [model, rules] of modelRules()) {
      const audience = audienceFor(model);
      const field = audience?.kind === 'conversation' ? audience.field : undefined;
      expect(rules.conversationField).toBe(field);
    }
  });

  it('reads each model\'s declared audience', () => {
    expect(audienceFor('directMessage')).toEqual({ kind: 'conversation', field: 'conversationId' });
    expect(audienceFor('pix')).toEqual({ kind: 'conversation', field: 'conversationId' });
    // Undeclared means every accepted friend, which is what these two models are.
    expect(audienceFor('story')).toBeUndefined();
    expect(audienceFor('profile')).toBeUndefined();
  });

  /**
   * **A model name the schema does not declare must not fall through to "everyone".** A lookup miss
   * and a deliberate "no audience declared" both produce `undefined`, which `resolveAudience` reads
   * as broadcast — so the miss has to raise instead. A typo is a bug, and a bug must not fail open
   * into a wider audience.
   */
  it('refuses an undeclared model rather than returning a broadcast audience', () => {
    // One character off `directMessage`.
    expect(() => audienceFor('directMessages')).toThrow(DirectRoutingUnresolved);
    expect(() => audienceFor('__proto__')).toThrow(DirectRoutingUnresolved);
  });
});
