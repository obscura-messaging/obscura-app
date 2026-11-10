import type { ConversationItem, PixItem } from '../domain/chats';
import type { Friend } from '../domain/friends';
import type { StoryItem } from '../domain/viewer';

// claude: dev-only sample data for reviewing the design with 0, 2 or 20 chats. Pure and deterministic
// apart from `now`. Faces and colors are the board's (design/obscura-ui/index.html).

export type SampleSize = 0 | 2 | 20;

export interface SampleFace {
  emoji: string;
  color: string;
}

export interface SampleData {
  friends: Friend[];
  items: ConversationItem[];
  stories: StoryItem[];
  typingUserId: string | null;
  faces: Readonly<Record<string, SampleFace>>;
}

const SAMPLE_PREFIX = 'sample-';
export const isSampleId = (userId: string) => userId.startsWith(SAMPLE_PREFIX);

interface Person {
  name: string;
  face: string;
  bg: string;
  // claude: minutes since the last thing in the chat
  ago: number;
  last: string;
  fromMe?: boolean;
  unread?: number;
  pix?: number;
  sentPix?: boolean;
  typing?: boolean;
  story?: boolean;
}

const MIN = 60000;
const HOUR = 60;
const DAY = 24 * HOUR;

// claude: the first two are the 2-chat set: one typing, one with an unopened photo.
const PEOPLE: Person[] = [
  { name: 'Teddy', face: '🐯', bg: '#FFB23F', ago: 0, last: 'wanna hang out later?', unread: 2, typing: true, story: true },
  { name: 'Jenny', face: '🦁', bg: '#62C6F3', ago: 21, last: 'look at this 👀', pix: 1, story: true },
  { name: 'Mango', face: '🐧', bg: '#FFD21A', ago: 5, last: 'lol same', unread: 1, story: true },
  { name: 'David', face: '🐘', bg: '#B79CF2', ago: 52, last: 'beach tomorrow?', unread: 1, story: true },
  { name: 'Leo', face: '🐵', bg: '#FFE07A', ago: 63, last: 'ok wait', pix: 2 },
  { name: 'Alex', face: '🐼', bg: '#FF8FB1', ago: 2.5 * HOUR, last: "let's gooo", story: true },
  { name: 'Mom', face: '🐸', bg: '#9FE3C4', ago: 4 * HOUR, last: 'call me', unread: 1, story: true },
  { name: 'Priya', face: '🦊', bg: '#FF9F6B', ago: 20 * HOUR, last: 'omg that sunset 🌅', sentPix: true },
  { name: 'Sam', face: '🐨', bg: '#A7D8FF', ago: 30 * HOUR, last: 'moved to 7?' },
  { name: 'Coach Kim', face: '🐮', bg: '#D7E3FF', ago: 2 * DAY, last: 'Practice is on!' },
  { name: 'Nina', face: '🐹', bg: '#FFC2D9', ago: 3 * DAY, last: 'who ate my yogurt' },
  { name: 'Grandpa', face: '🐢', bg: '#B8F0A6', ago: 6 * DAY, last: 'proud of you kiddo' },
  { name: 'Zoe', face: '🐰', bg: '#E8D4FF', ago: 12 * DAY, last: 'see u tmrw ✨', fromMe: true },
  { name: 'Ken', face: '🐙', bg: '#FFB3A7', ago: 40 * DAY, last: 'flights booked!' },
  { name: 'Maya', face: '🐶', bg: '#FFB23F', ago: 4 * DAY, last: 'haha ok', fromMe: true },
  { name: 'Oscar', face: '🦉', bg: '#7ED957', ago: 5 * DAY, last: 'brb' },
  { name: 'Ruby', face: '🐞', bg: '#FF8FB1', ago: 15 * DAY, last: 'thank youuu 💗' },
  { name: 'Felix', face: '🐱', bg: '#A7D8FF', ago: 9 * HOUR, last: 'did you finish the hw?', fromMe: true },
  { name: 'Ivy', face: '🦋', bg: '#B79CF2', ago: 21 * DAY, last: 'miss you!' },
  { name: 'Theo', face: '🐻', bg: '#9FE3C4', ago: 60 * DAY, last: 'gg' },
];

// claude: the board's chat thread, as earlier history
const FILLER: { me: boolean; text: string }[] = [
  { me: false, text: 'Hey! what are you doing' },
  { me: true, text: 'just chilling 😎' },
  { me: false, text: 'nicee!' },
  { me: true, text: "i'll text you when i'm free!" },
];
const UNREAD_EXTRA = ['yesss 🔥', 'okayyy ✌️'];

const ATTACHMENT = { id: 'sample', contentKey: '', nonce: '', mediaType: 'photo' as const };

function thread(p: Person, userId: string, myUserId: string, now: number): ConversationItem[] {
  const end = now - p.ago * MIN;
  const unread = p.unread ?? 0;
  const lines = [
    ...FILLER,
    ...(p.sentPix ? [{ me: true, pix: true, text: '' }] : []),
    ...UNREAD_EXTRA.slice(0, Math.max(0, unread - 1)).map(text => ({ me: false, text })),
    { me: p.fromMe ?? false, text: p.last },
  ];
  const items: ConversationItem[] = lines.map((l, i) => {
    const sentAt = end - (lines.length - 1 - i) * MIN - (p.pix ?? 0) * MIN;
    const unseen = !l.me && i >= lines.length - unread;
    const base = {
      id: `${userId}-m${i}`, peerUserId: userId, authorUserId: l.me ? myUserId : userId, sentAt,
      viewedAt: unseen ? null : sentAt,
    };
    return 'pix' in l ? pixItem(base) : { ...base, kind: 'message', content: l.text };
  });
  for (let i = 0; i < (p.pix ?? 0); i++) {
    const sentAt = end - ((p.pix ?? 0) - 1 - i) * MIN;
    items.push(pixItem({ id: `${userId}-p${i}`, peerUserId: userId, authorUserId: userId, sentAt, viewedAt: null }));
  }
  return items;
}

const pixItem = (base: Omit<PixItem, 'kind' | 'attachment' | 'caption' | 'captionMeta' | 'displayDuration'>): PixItem =>
  ({ ...base, kind: 'pix', attachment: ATTACHMENT, caption: null, captionMeta: null, displayDuration: 0 });

export function sampleData(size: SampleSize, myUserId: string, now = Date.now()): SampleData {
  const faces: Record<string, SampleFace> = {};
  const data: SampleData = { friends: [], items: [], stories: [], typingUserId: null, faces };
  PEOPLE.slice(0, size).forEach((p, i) => {
    const userId = `${SAMPLE_PREFIX}${i}`;
    data.friends.push({ userId, username: p.name, status: 'accepted' });
    data.items.push(...thread(p, userId, myUserId, now));
    faces[userId] = { emoji: p.face, color: p.bg };
    if (p.typing) data.typingUserId = userId;
    if (p.story) {
      data.stories.push({
        id: `${userId}-s`, authorUserId: userId, sentAt: now - (i + 1) * 17 * MIN,
        content: '', attachment: null, captionMeta: null,
      });
    }
  });
  return data;
}
