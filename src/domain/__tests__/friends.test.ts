import {
  acceptedFriends,
  displayNameFor,
  friendProfileEntries,
  pendingFriends,
  pendingFriendSubtitle,
  removeFriendPrompt,
  sendButtonLabel,
  sendOutcomeToast,
  type Friend,
  type ProfileItem,
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

    expect(friendProfileEntries(profiles, identity)).toEqual([{ entry: profiles[1], name: 'bob' }]);
  });
});

describe('pendingFriendSubtitle, removeFriendPrompt, sendOutcomeToast & sendButtonLabel', () => {
  it('derives pending row subtitles from relationship status and primary authority', () => {
    expect(pendingFriendSubtitle(SENT, 'primary')).toBe('Request sent');
    expect(pendingFriendSubtitle(DAVE, 'primary')).toBe('Wants to be friends');
    expect(pendingFriendSubtitle(DAVE, 'unknown')).toBe('Wants to be friends');
    expect(pendingFriendSubtitle(DAVE, 'linked')).toBe(
      'Wants to be friends · accept on your primary',
    );
  });

  it('derives confirmation dialog copy for declining, cancelling, or removing a friend', () => {
    expect(removeFriendPrompt(DAVE)).toEqual({
      title: 'Decline dave?',
      body: 'This pending friend request will be removed.',
      actionLabel: 'Decline',
    });
    expect(removeFriendPrompt(SENT)).toEqual({
      title: 'Cancel request to eve?',
      body: 'This pending friend request will be removed.',
      actionLabel: 'Cancel Request',
    });
    expect(removeFriendPrompt(BOB)).toEqual({
      title: 'Remove bob?',
      body: 'You will no longer be friends with this user.',
      actionLabel: 'Remove',
    });
  });

  it('formats recipient picker send outcomes and button labels', () => {
    expect(sendOutcomeToast(2, true, ['bob'])).toEqual({
      kind: 'error',
      message: 'Not delivered to bob',
    });
    expect(sendOutcomeToast(1, false, [])).toEqual({
      kind: 'success',
      message: 'Sent to 1 friend',
    });
    expect(sendOutcomeToast(2, true, [])).toEqual({
      kind: 'success',
      message: 'Sent to 2 friends + story',
    });
    expect(sendButtonLabel(0, false, false)).toBe('Select recipients');
    expect(sendButtonLabel(2, true, false)).toBe('Send to 3');
    expect(sendButtonLabel(1, false, true)).toBe('Sending…');
  });
});
