import { MODELS, declarationOf } from '../schema';
import { DirectRoutingUnresolved } from '../audience';

describe('the schema', () => {
  it('declares merge, audience, and expiry rules for every model', () => {
    expect([...MODELS.keys()].sort()).toEqual(['directMessage', 'pix', 'profile', 'seen', 'story']);
    expect(declarationOf('directMessage')).toMatchObject({
      merge: 'APPEND',
      audience: 'conversation',
      expiry: { kind: 'afterSeen' },
    });
    expect(declarationOf('pix')).toMatchObject({
      merge: 'APPEND',
      audience: 'conversation',
      expiry: { kind: 'afterSeen' },
    });
    expect(declarationOf('seen')).toMatchObject({
      merge: 'APPEND',
      audience: 'conversation',
      expiry: { kind: 'withTarget' },
    });
    expect(declarationOf('story')).toMatchObject({
      merge: 'APPEND',
      audience: 'friends',
      expiry: { kind: 'afterSent' },
    });
    expect(declarationOf('story').ownerIdPrefix).toBeUndefined();
    expect(declarationOf('profile')).toMatchObject({
      merge: 'REPLACE',
      audience: 'friends',
      ownerIdPrefix: 'profile_',
      expiry: { kind: 'never' },
    });
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
