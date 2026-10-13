import { conversationId, parseConversationId } from '../conversation';

describe('the constructor', () => {
  /**
   * The id must be identical computed from either side, or one participant would address the
   * conversation and the other would not.
   */
  it('is the same from both sides', () => {
    expect(conversationId('bbb', 'aaa')).toBe(conversationId('aaa', 'bbb'));
    expect(conversationId('aaa', 'bbb')).toBe('aaa_bbb');
  });

  /** Everything the parser accepts is something the constructor built. */
  it('always builds a form the parser accepts', () => {
    expect(parseConversationId(conversationId('bbb', 'aaa'))).toEqual(['aaa', 'bbb']);
    expect(parseConversationId(conversationId('aaa', 'bbb'))).toEqual(['aaa', 'bbb']);
  });
});

describe('the parser', () => {
  it('returns both participants of a canonical id', () => {
    expect(parseConversationId('aaa_bbb')).toEqual(['aaa', 'bbb']);
  });

  it('REFUSES a reversed id rather than sorting it', () => {
    expect(parseConversationId('bbb_aaa')).toBeNull();
  });

  /** Exactly two NON-EMPTY parts. Filtering empties out before counting accepts every one of these. */
  it.each(['a__b', '_a_b', 'a_b_', '__a___b__', '_a', 'a_', '', '_'])(
    'refuses %p',
    (id) => {
      expect(parseConversationId(id)).toBeNull();
    },
  );

  /** Anything but two participants is not a conversation this app knows how to address. */
  it.each(['abc', 'a_b_c'])('refuses %p as a two-party id', (id) => {
    expect(parseConversationId(id)).toBeNull();
  });
});

