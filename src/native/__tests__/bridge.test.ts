import { Obscura, onObscuraEvent, type ObscuraEvent } from '../ObscuraModule';
import { getFakeBridge } from '../__fixtures__/reactNativeMock';

const bridge = getFakeBridge();

describe('onObscuraEvent', () => {
  it('delivers native events and stops after unsubscribe', () => {
    const seen: ObscuraEvent[] = [];
    const off = onObscuraEvent((e) => seen.push(e));

    bridge.__setConnectionState('connecting');
    expect(seen).toEqual([{ type: 'connectionChanged', state: 'connecting' }]);

    off();
    bridge.__setConnectionState('connected');

    expect(seen).toHaveLength(1);
    expect(bridge.__listenerCount()).toBe(0);
  });
});

describe('Obscura.getMessages', () => {
  it('transforms RawConversationItem into DirectMessageItem | PixItem, parses captionMeta, and normalizes mediaType', async () => {
    const boldMeta = {
      style: 'bold' as const,
      x: 0.5,
      y: 0.5,
      rot: 0,
      scale: 1,
      color: '#ffffff',
      font: 0,
    };

    bridge.messages = [
      {
        kind: 'message',
        id: 'dm_1',
        peerUserId: 'u_bob',
        authorUserId: 'u_bob',
        sentAt: 100,
        viewedAt: null,
        content: 'hello',
      },
      {
        kind: 'pix',
        id: 'pix_nested',
        peerUserId: 'u_bob',
        authorUserId: 'u_bob',
        sentAt: 200,
        viewedAt: 250,
        attachment: { id: 'att_1', contentKey: 'k1', nonce: 'n1', mediaType: 'video' },
        caption: 'clip',
        captionMeta: JSON.stringify(boldMeta),
        displayDuration: 8,
      },
      {
        kind: 'pix',
        id: 'pix_photo_fallback',
        peerUserId: 'u_bob',
        authorUserId: 'u_self',
        sentAt: 300,
        viewedAt: null,
        attachment: { id: 'att_2', contentKey: 'k2', nonce: 'n2', mediaType: 'image/jpeg' },
        caption: null,
        captionMeta: 'invalid-json',
        displayDuration: 5,
      },
    ];

    const items = await Obscura.getMessages();

    expect(items).toEqual([
      {
        kind: 'message',
        id: 'dm_1',
        peerUserId: 'u_bob',
        authorUserId: 'u_bob',
        sentAt: 100,
        viewedAt: null,
        content: 'hello',
      },
      {
        kind: 'pix',
        id: 'pix_nested',
        peerUserId: 'u_bob',
        authorUserId: 'u_bob',
        sentAt: 200,
        viewedAt: 250,
        attachment: { id: 'att_1', contentKey: 'k1', nonce: 'n1', mediaType: 'video' },
        caption: 'clip',
        captionMeta: boldMeta,
        displayDuration: 8,
      },
      {
        kind: 'pix',
        id: 'pix_photo_fallback',
        peerUserId: 'u_bob',
        authorUserId: 'u_self',
        sentAt: 300,
        viewedAt: null,
        attachment: { id: 'att_2', contentKey: 'k2', nonce: 'n2', mediaType: 'photo' },
        caption: null,
        captionMeta: null,
        displayDuration: 5,
      },
    ]);
  });
});

describe('Obscura.getStories', () => {
  it('transforms RawStoryItem into StoryItem, parses captionMeta, and handles null vs non-null attachments', async () => {
    const barMeta = { style: 'bar' as const, y: 0.4 };

    bridge.stories = [
      {
        id: 's_nested',
        authorUserId: 'u_bob',
        sentAt: 100,
        content: 'sunset',
        attachment: { id: 'att_1', contentKey: 'k', nonce: 'n', mediaType: 'photo' },
        captionMeta: JSON.stringify(barMeta),
      },
      {
        id: 's_video',
        authorUserId: 'u_bob',
        sentAt: 200,
        content: 'movie',
        attachment: { id: 'att_2', contentKey: 'k2', nonce: 'n2', mediaType: 'video' },
        captionMeta: null,
      },
      {
        id: 's_null_att',
        authorUserId: 'u_bob',
        sentAt: 300,
        content: 'text only',
        attachment: null,
        captionMeta: null,
      },
      {
        id: 's_omitted_att',
        authorUserId: 'u_bob',
        sentAt: 400,
        content: 'also text only',
        captionMeta: null,
      },
    ];

    const stories = await Obscura.getStories();

    expect(stories).toEqual([
      {
        id: 's_nested',
        authorUserId: 'u_bob',
        sentAt: 100,
        content: 'sunset',
        attachment: { id: 'att_1', contentKey: 'k', nonce: 'n', mediaType: 'photo' },
        captionMeta: barMeta,
      },
      {
        id: 's_video',
        authorUserId: 'u_bob',
        sentAt: 200,
        content: 'movie',
        attachment: { id: 'att_2', contentKey: 'k2', nonce: 'n2', mediaType: 'video' },
        captionMeta: null,
      },
      {
        id: 's_null_att',
        authorUserId: 'u_bob',
        sentAt: 300,
        content: 'text only',
        attachment: null,
        captionMeta: null,
      },
      {
        id: 's_omitted_att',
        authorUserId: 'u_bob',
        sentAt: 400,
        content: 'also text only',
        attachment: null,
        captionMeta: null,
      },
    ]);
  });
});

describe('Obscura.sendPix & Obscura.postStory', () => {
  it('serializes CaptionMeta objects to JSON strings before calling the native bridge', async () => {
    bridge.__setFriends([{ userId: 'u_bob', username: 'bob', status: 'accepted' }]);
    const meta = { style: 'bar' as const, y: 0.72 };

    await Obscura.sendPix('u_bob', 'att_1', 'k', 'n', 'photo', 'hi', meta, 5);
    await Obscura.postStory('story', 'att_1', 'k', 'n', 'photo', meta);
    await Obscura.postStory('preencoded', null, null, null, null, '{"style":"bar","y":0.2}');

    expect(bridge.messages).toEqual([
      expect.objectContaining({ kind: 'pix', captionMeta: JSON.stringify(meta) }),
    ]);
    expect(bridge.stories).toEqual([
      expect.objectContaining({ content: 'story', captionMeta: JSON.stringify(meta) }),
      expect.objectContaining({ content: 'preencoded', captionMeta: '{"style":"bar","y":0.2}' }),
    ]);
  });
});

describe('error code propagation', () => {
  it('propagates native rejection codes on one-shot failures without poisoning subsequent calls', async () => {
    bridge.__failNext('sendMessage', 'SEND_FAILED', 'reached nobody');

    await expect(Obscura.sendMessage('u_bob', 'hi')).rejects.toMatchObject({ code: 'SEND_FAILED' });
    await expect(Obscura.sendMessage('u_bob', 'hi again')).resolves.toEqual(expect.any(String));
  });
});

