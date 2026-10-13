import { resolveAudience, DirectRoutingUnresolved } from '../audience';
import { conversationId } from '../conversation';
import type { Friend } from '../../native/ObscuraModule';

const SELF = 'uMe';
const FRIENDS: Friend[] = [
  { userId: 'uA', username: 'alice', status: 'accepted' },
  { userId: 'uB', username: 'bob', status: 'accepted' },
  { userId: 'uC', username: 'carol', status: 'accepted' },
];

function conversation(convId: unknown, self = SELF, friends = FRIENDS): string[] {
  return resolveAudience('conversation', { conversationId: convId }, self, friends);
}

describe('conversation audience', () => {
  it('resolves a canonical two-party conversation to the other participant', () => {
    expect(conversation(conversationId(SELF, 'uB'))).toEqual(['uB']);
  });

  it('resolves the same conversation from either participant', () => {
    const convId = conversationId(SELF, 'uB');
    const bobsFriends: Friend[] = [{ userId: SELF, username: 'me', status: 'accepted' }];

    expect(conversation(convId)).toEqual(['uB']);
    expect(conversation(convId, 'uB', bobsFriends)).toEqual([SELF]);
  });

  it('LEAK GUARD: a malformed 3-party id fails loud, never broadcasts', () => {
    expect(() => conversation('uMe_uB_uC')).toThrow(DirectRoutingUnresolved);
  });

  it('carries the DIRECT_ROUTING_UNRESOLVED code', () => {
    expect(() => conversation('uMe_uB_uC')).toThrow(expect.objectContaining({ code: 'DIRECT_ROUTING_UNRESOLVED' }));
  });

  it.each([undefined, '', 42])('fails loud on a missing or non-string id (%p)', (convId) => {
    expect(() => conversation(convId)).toThrow(DirectRoutingUnresolved);
  });

  it.each(['uMe__uB', '_uMe_uB', 'uMe_uB_', '__uMe___uB__', '_uMe', 'uMe_'])(
    'rejects %p as a non-canonical two-party id',
    (convId) => {
      expect(() => conversation(convId)).toThrow(DirectRoutingUnresolved);
    },
  );

  it('LEAK GUARD: a reversed conversation id fails loud', () => {
    const reversed = conversationId(SELF, 'uB').split('_').reverse().join('_');

    expect(() => conversation(reversed)).toThrow(DirectRoutingUnresolved);
  });

  /** Two of my friends talking to each other is not my conversation. */
  it('LEAK GUARD: a conversation this user is not part of fails loud', () => {
    expect(() => conversation(conversationId('uA', 'uB'))).toThrow(DirectRoutingUnresolved);
  });

  it('LEAK GUARD: a participant who is not an accepted friend is dropped', () => {
    expect(conversation(conversationId(SELF, 'uStranger'))).toEqual([]);
  });

  it('LEAK GUARD: a pending friend is not reached', () => {
    const pending: Friend[] = [...FRIENDS, { userId: 'uD', username: 'dave', status: 'pending_received' }];

    expect(conversation(conversationId(SELF, 'uD'), SELF, pending)).toEqual([]);
  });
});

describe('friends audience', () => {
  it('resolves to every accepted friend', () => {
    expect(resolveAudience('friends', {}, SELF, FRIENDS).sort()).toEqual(['uA', 'uB', 'uC']);
  });

  it('never includes a pending friend', () => {
    const withPending: Friend[] = [...FRIENDS, { userId: 'uD', username: 'dave', status: 'pending_received' }];

    expect(resolveAudience('friends', {}, SELF, withPending)).not.toContain('uD');
  });

  it('never names this user', () => {
    const selfListed: Friend[] = [...FRIENDS, { userId: SELF, username: 'me', status: 'accepted' }];

    expect(resolveAudience('friends', {}, SELF, selfListed)).not.toContain(SELF);
  });
});
