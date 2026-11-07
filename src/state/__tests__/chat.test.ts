import { nextPeerTypingState, notifyTyping, sendChatMessage } from '../chat';
import { loadSession, resetSession, useStore } from '../store';
import { Obscura, type Friend } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';
import { getJsLog } from '../../utils/log';

const bridge = getFakeBridge();

const ALICE = '11111111-1111-4111-8111-111111111111';
const DEVICE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BOB: Friend = {
  userId: '22222222-2222-4222-8222-222222222222',
  username: 'bob',
  status: 'accepted',
};

beforeEach(() => {
  resetSession();
  bridge.__reset();
  bridge.__authenticate({ userId: ALICE, username: 'alice', deviceId: DEVICE });
});

describe('sendChatMessage', () => {
  it('stops typing, sends the message, and refreshes the message slice', async () => {
    bridge.__setFriends([BOB]);
    await loadSession();

    await sendChatMessage(BOB.userId, 'hello bob');

    expect(bridge.__calls).toContain('stopTyping');
    expect(await Obscura.getMessages()).toEqual([
      expect.objectContaining({ peerUserId: BOB.userId, kind: 'message', content: 'hello bob' }),
    ]);
    expect(useStore.getState().messages).toEqual([
      expect.objectContaining({ peerUserId: BOB.userId, kind: 'message', content: 'hello bob' }),
    ]);
  });
});

describe('notifyTyping & nextPeerTypingState', () => {
  it('sends sendTyping on non-empty input, stopTyping when cleared, and logs failures without throwing', async () => {
    await notifyTyping(BOB.userId, '', '');
    await notifyTyping(BOB.userId, '', 'h');
    await notifyTyping(BOB.userId, 'h', 'hi');
    await notifyTyping(BOB.userId, 'hi', '');

    expect(bridge.__calls.filter((c) => c === 'sendTyping')).toHaveLength(2);
    expect(bridge.__calls.filter((c) => c === 'stopTyping')).toHaveLength(1);

    bridge.__failNext('sendTyping', 'SEND_FAILED', 'send typing err');
    bridge.__failNext('stopTyping', 'SEND_FAILED', 'stop typing err');
    await notifyTyping(BOB.userId, '', 'h');
    await notifyTyping(BOB.userId, 'h', '');
    expect(getJsLog().some((l) => l.includes('[typing.send] send typing err'))).toBe(true);
    expect(getJsLog().some((l) => l.includes('[typing.stop] stop typing err'))).toBe(true);
  });

  it('updates peer typing state on typingChanged for that peer and resets on directMessage receipt', () => {
    expect(nextPeerTypingState(false, BOB.userId, {
      type: 'typingChanged', peerUserId: BOB.userId, typing: true,
    })).toBe(true);
    expect(nextPeerTypingState(true, BOB.userId, {
      type: 'typingChanged', peerUserId: 'other-peer', typing: false,
    })).toBe(true);
    expect(nextPeerTypingState(false, BOB.userId, {
      type: 'typingChanged', peerUserId: 'other-peer', typing: true,
    })).toBe(false);
    expect(nextPeerTypingState(true, BOB.userId, {
      type: 'messageReceived', model: 'story',
    })).toBe(true);
    expect(nextPeerTypingState(true, BOB.userId, {
      type: 'messageReceived', model: 'directMessage',
    })).toBe(false);
    expect(nextPeerTypingState(true, BOB.userId, {
      type: 'friendsChanged',
    })).toBe(true);
  });
});
