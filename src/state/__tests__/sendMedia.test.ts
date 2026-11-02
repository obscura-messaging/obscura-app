import { loadAttachmentUri, sendCapture, type Capture } from '../sendMedia';
import { resetSession, useStore } from '../store';
import { Obscura, type Friend } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

const SELF = '11111111-1111-4111-8111-111111111111';
const BOB: Friend = { userId: '22222222-2222-4222-8222-222222222222', username: 'bob', status: 'accepted' };
const CAROL: Friend = { userId: '33333333-3333-4333-8333-333333333333', username: 'carol', status: 'accepted' };
const CAPTURE: Capture = { path: '/fake/capture.jpg', mediaType: 'photo', caption: 'hi', displayDuration: 3 };

beforeEach(() => {
  resetSession();
  bridge.__authenticate({ userId: SELF });
  bridge.__setFriends([BOB, CAROL]);
  useStore.setState({ authed: true, myUserId: SELF, myDeviceId: 'device', friends: [BOB, CAROL] });
});

describe('sendCapture', () => {
  it('uploads once, sends a pix per recipient and a story, then deletes the capture', async () => {
    expect(await sendCapture(CAPTURE, [BOB, CAROL], true)).toEqual([]);

    expect(bridge.__calls.filter((c) => c === 'uploadAttachment')).toHaveLength(1);
    const pix = bridge.__sent.filter((x) => x.modelKey === 'pix');
    expect(pix.map((x) => x.recipientUserIds)).toEqual([[BOB.userId], [CAROL.userId]]);
    expect(pix[0].payload).toMatchObject({
      peerUserId: BOB.userId,
      caption: 'hi',
      displayDuration: 3,
      mediaType: 'photo',
      captionMeta: null,
    });
    expect(bridge.__sent.find((x) => x.modelKey === 'story')?.payload.content).toBe('hi');
    expect(useStore.getState().messages).toHaveLength(2);
    expect(useStore.getState().stories).toHaveLength(1);
    expect(bridge.__calls).toContain('deleteFile');
  });

  it('reports recipients it could not reach and keeps their pix', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.__setUnreachable([CAROL.userId]);

    expect(await sendCapture(CAPTURE, [BOB, CAROL], false)).toEqual(['carol']);

    expect(await Obscura.getMessages()).toHaveLength(2);
    expect(useStore.getState().messages).toHaveLength(2);
    warn.mockRestore();
  });

  it('reports an undelivered story, keeps it in the outbox, and still deletes temp files', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.__setUnreachable([BOB.userId, CAROL.userId]);

    expect(await sendCapture(CAPTURE, [], true)).toEqual(['My story']);

    expect(await Obscura.getStories()).toHaveLength(1);
    expect(useStore.getState().stories).toHaveLength(1);
    expect(bridge.__calls).toContain('deleteFile');
    warn.mockRestore();
  });

  it('does not resize a video', async () => {
    await sendCapture({ ...CAPTURE, mediaType: 'video' }, [BOB], false);

    expect(bridge.__calls).not.toContain('resizeImage');
  });

  it('serializes CaptionMeta at the bridge boundary and caches downloaded attachment URIs by id', async () => {
    const meta = { style: 'bar' as const, y: 0.5 };
    await sendCapture({ ...CAPTURE, captionMeta: meta }, [BOB], true);

    const [msg] = useStore.getState().messages;
    if (msg.kind !== 'pix') throw new Error('Expected pix');
    expect(msg.captionMeta).toEqual(meta);
    expect(useStore.getState().stories[0].captionMeta).toEqual(meta);

    const cache = new Map<string, string>();
    const uri1 = await loadAttachmentUri(msg.attachment, cache);
    const uri2 = await loadAttachmentUri(msg.attachment, cache);
    expect(uri1).toBe(uri2);
    expect(bridge.__calls.filter((c) => c === 'downloadAttachment')).toHaveLength(1);
  });
});
