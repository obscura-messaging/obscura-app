import {
  createTestCapture, discardCapture, loadAttachmentUri, prewarmAudio, sendCapture, type Capture,
} from '../sendMedia';
import { toPath } from '../../utils/files';
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

    expect(bridge.__calls.filter((c) => c === 'sendCapture')).toHaveLength(1);
    expect(await Obscura.getMessages()).toEqual([
      expect.objectContaining({
        kind: 'pix',
        peerUserId: BOB.userId,
        caption: 'hi',
        displayDuration: 3,
        captionMeta: null,
        attachment: expect.objectContaining({ mediaType: 'photo' }),
      }),
      expect.objectContaining({
        kind: 'pix',
        peerUserId: CAROL.userId,
        caption: 'hi',
        displayDuration: 3,
        captionMeta: null,
        attachment: expect.objectContaining({ mediaType: 'photo' }),
      }),
    ]);
    expect(await Obscura.getStories()).toEqual([
      expect.objectContaining({ content: 'hi' }),
    ]);
    expect(useStore.getState().messages).toHaveLength(2);
    expect(useStore.getState().stories).toHaveLength(1);
    expect(bridge.deletedFiles).toContain(CAPTURE.path);
  });

  it('reports recipients it could not reach and keeps their pix', async () => {
    bridge.__setUnreachable([CAROL.userId]);

    expect(await sendCapture(CAPTURE, [BOB, CAROL], false)).toEqual(['carol']);

    expect(await Obscura.getMessages()).toHaveLength(2);
    expect(useStore.getState().messages).toHaveLength(2);
  });

  it('reports an undelivered story, keeps it in the outbox, and still deletes temp files', async () => {
    bridge.__setUnreachable([BOB.userId, CAROL.userId]);
    bridge.__calls.length = 0;

    expect(await sendCapture(CAPTURE, [], true)).toEqual(['My story']);

    expect(bridge.__calls).not.toContain('getMessages');
    expect(await Obscura.getStories()).toHaveLength(1);
    expect(useStore.getState().stories).toHaveLength(1);
    expect(bridge.__calls).toContain('deleteFile');
  });

  it('rejects and keeps the capture when the upload fails', async () => {
    bridge.__failNext('sendCapture', 'HTTP_ERROR');

    await expect(sendCapture(CAPTURE, [BOB], true)).rejects.toMatchObject({ code: 'HTTP_ERROR' });
    expect(bridge.deletedFiles).not.toContain(CAPTURE.path);
  });

  it('does not resize a video', async () => {
    await sendCapture({ ...CAPTURE, mediaType: 'video' }, [BOB], false);

    expect(bridge.__calls).not.toContain('resizeImage');
  });

  it('serializes CaptionMeta at the bridge boundary and caches downloaded attachment URIs by entry id', async () => {
    const meta = { style: 'bar' as const, y: 0.5 };
    await sendCapture({ ...CAPTURE, captionMeta: meta }, [BOB], true);

    const [msg] = useStore.getState().messages;
    if (msg.kind !== 'pix') throw new Error('Expected pix');
    expect(msg.captionMeta).toEqual(meta);
    expect(useStore.getState().stories[0].captionMeta).toEqual(meta);

    const cache = new Map<string, string>();
    bridge.__calls.length = 0;
    const [uri1, uri2] = await Promise.all([
      loadAttachmentUri(msg.id, cache),
      loadAttachmentUri(msg.id, cache),
    ]);
    const uri3 = await loadAttachmentUri(msg.id, cache);
    expect(uri1).toBe(`file:///fake/cache/${msg.id}`);
    expect(uri1).toBe(uri2);
    expect(uri1).toBe(uri3);
    expect(bridge.__calls.filter((c) => c === 'downloadAttachment')).toHaveLength(1);
  });

  it('falls back to the original path if resizeImage fails, and supports capture helpers', async () => {
    bridge.__failNext('resizeImage', 'STORAGE_ERROR');
    bridge.__failNext('deleteFile', 'STORAGE_ERROR');

    expect(await sendCapture(CAPTURE, [BOB], false)).toEqual([]);
    expect(bridge.__calls).toContain('sendCapture');

    const testPath = await createTestCapture();
    expect(testPath).toBe('/fake/test.jpg');
    expect(toPath('file:///fake/test.jpg')).toBe('/fake/test.jpg');
    expect(toPath('/fake/test.jpg')).toBe('/fake/test.jpg');
    prewarmAudio();
    discardCapture(testPath);
    expect(bridge.__calls).toContain('prewarmAudioSession');
    expect(bridge.deletedFiles).toContain('/fake/test.jpg');

    bridge.__failNext('prewarmAudioSession', 'STORAGE_ERROR');
    bridge.__failNext('deleteFile', 'STORAGE_ERROR');
    prewarmAudio();
    discardCapture(testPath);
    await Promise.resolve();
  });
});
