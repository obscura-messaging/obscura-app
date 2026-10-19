import { sendCapture, type Capture } from '../sendMedia';
import { resetSession, useStore } from '../store';
import { conversationId } from '../../domain/conversation';
import { Obscura, type Friend } from '../../native/ObscuraModule';
import { getFakeBridge } from '../../native/__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

const SELF = '11111111-1111-4111-8111-111111111111';
const BOB: Friend = { userId: '22222222-2222-4222-8222-222222222222', username: 'bob', status: 'accepted' };
const CAROL: Friend = { userId: '33333333-3333-4333-8333-333333333333', username: 'carol', status: 'accepted' };
const CAPTURE: Capture = { path: '/tmp/capture.jpg', mediaType: 'photo', caption: 'hi', displayDuration: 3 };

beforeEach(() => {
  resetSession();
  bridge.__authenticate({ userId: SELF });
  useStore.setState({ authed: true, myUserId: SELF, myDeviceId: 'device', friends: [BOB, CAROL] });
});

describe('sendCapture', () => {
  it('uploads once, sends a pix per recipient and a story, then deletes the capture', async () => {
    expect(await sendCapture(CAPTURE, [BOB, CAROL], true)).toEqual([]);

    expect(bridge.__calls.filter((c) => c === 'uploadAttachment')).toHaveLength(1);
    const pix = bridge.__sent.filter((x) => x.modelKey === 'pix');
    expect(pix.map((x) => JSON.parse(x.payloadJson).conversationId)).toEqual([
      conversationId(SELF, BOB.userId), conversationId(SELF, CAROL.userId),
    ]);
    expect(JSON.parse(pix[0].payloadJson)).toMatchObject({ caption: 'hi', displayDuration: 3, mediaType: 'photo' });
    expect(JSON.parse(pix[0].payloadJson)).not.toHaveProperty('captionMeta');
    expect(JSON.parse(bridge.__sent.find((x) => x.modelKey === 'story')!.payloadJson).content).toBe('hi');
    expect(bridge.__calls).toContain('deleteFile');
  });

  it('reports recipients it could not reach and keeps their pix', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    bridge.__setUnreachable([CAROL.userId]);

    expect(await sendCapture(CAPTURE, [BOB, CAROL], false)).toEqual(['carol']);

    expect(await Obscura.entryAll('pix')).toHaveLength(2);
    warn.mockRestore();
  });

  it('does not resize a video', async () => {
    await sendCapture({ ...CAPTURE, mediaType: 'video' }, [BOB], false);

    expect(bridge.__calls).not.toContain('resizeImage');
  });
});
