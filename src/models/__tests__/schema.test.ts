import { MODELS, declarationOf } from '../schema';
import { DirectRoutingUnresolved } from '../../domain/audience';

describe('the schema', () => {
  /** Pinned against DOMAIN_CONTRACT's "Models" table; a well-typed declaration can still be wrong. */
  it('matches the contract table', () => {
    expect([...MODELS.keys()].sort()).toEqual(['directMessage', 'pix', 'profile', 'seen', 'story']);
    expect(declarationOf('directMessage')).toMatchObject({ merge: 'APPEND', audience: 'conversation' });
    expect(declarationOf('pix')).toMatchObject({ merge: 'APPEND', audience: 'conversation' });
    expect(declarationOf('seen')).toMatchObject({ merge: 'APPEND', audience: 'conversation' });
    expect(declarationOf('story')).toMatchObject({ merge: 'APPEND', audience: 'friends' });
    expect(declarationOf('story').ownerIdPrefix).toBeUndefined();
    expect(declarationOf('profile')).toMatchObject({ merge: 'REPLACE', audience: 'friends', ownerIdPrefix: 'profile_' });
  });

  it('requires every conversation model to declare a conversationId', () => {
    for (const declaration of MODELS.values()) {
      if (declaration.audience === 'conversation') {
        expect(declaration.fields.conversationId).toBe('string');
      }
    }
  });

  /** A typo in a model name must not fall through to some audience. */
  it('refuses an undeclared model', () => {
    expect(() => declarationOf('directMessages')).toThrow(DirectRoutingUnresolved);
    expect(() => declarationOf('__proto__')).toThrow(DirectRoutingUnresolved);
  });
});
