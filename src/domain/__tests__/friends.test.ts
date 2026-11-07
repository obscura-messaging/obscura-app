import {
  acceptedFriends, displayNameFor, friendProfileEntries, pendingFriends,
  type Friend, type ProfileItem,
} from '../friends';

const ME = 'uMe';
const BOB: Friend = { userId: 'uBob', username: 'bob', status: 'accepted' };
const CAROL: Friend = { userId: 'uCarol', username: 'carol', status: 'accepted' };
const DAVE: Friend = { userId: 'uDave', username: 'dave', status: 'pending_received' };
const SENT: Friend = { userId: 'uEve', username: 'eve', status: 'pending_sent' };

const identity = { myUserId: ME, myUsername: 'me', friends: [BOB, CAROL, DAVE] };

describe('acceptedFriends & pendingFriends', () => {
  it('partitions the friend list into accepted vs pending relationships', () => {
    const all = [BOB, DAVE, CAROL, SENT];
    expect(acceptedFriends(all)).toEqual([BOB, CAROL]);
    expect(pendingFriends(all)).toEqual([DAVE, SENT]);
  });
});

describe('displayNameFor', () => {
  it('resolves own username and accepted friends while returning null for empty, pending, or unknown IDs', () => {
    expect(displayNameFor('', identity)).toBeNull();
    expect(displayNameFor(ME, identity)).toBe('me');
    expect(displayNameFor(BOB.userId, identity)).toBe('bob');
    expect(displayNameFor(DAVE.userId, identity)).toBeNull();
    expect(displayNameFor('uStranger', identity)).toBeNull();
  });
});

describe('friendProfileEntries', () => {
  it('projects friend profiles only for accepted friends, never self or strangers', () => {
    const profiles: ProfileItem[] = [
      { userId: ME, authorDeviceId: 'd', updatedAt: 1, displayName: 'Me', bio: '' },
      { userId: BOB.userId, authorDeviceId: 'd', updatedAt: 1, displayName: 'Bobby', bio: 'hi' },
      { userId: DAVE.userId, authorDeviceId: 'd', updatedAt: 1, displayName: 'Dave', bio: '' },
      { userId: 'uStranger', authorDeviceId: 'd', updatedAt: 1, displayName: 'Who', bio: '' },
    ];

    expect(friendProfileEntries(profiles, identity)).toEqual([
      { entry: profiles[1], name: 'bob' },
    ]);
  });
});
