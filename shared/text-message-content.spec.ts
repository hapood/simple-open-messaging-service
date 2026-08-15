import { describe, expect, it } from 'vitest';
import {
  hasUnpairedSurrogate,
  parseTextMessageContent,
  requireTextMessageContent,
  stringifyTextMessageContent,
  TEXT_MESSAGE_MAX_CODE_POINTS,
  unicodeCodePointLength,
} from './text-message-content.js';

describe('text message content protocol', () => {
  it('round-trips text and a server-authored quote', () => {
    const wire = stringifyTextMessageContent({
      text: 'hello',
      quote: { seq: 31, author: 'Alice', body: 'original' },
    });
    expect(parseTextMessageContent(wire)).toEqual({
      text: 'hello',
      quote: { seq: 31, author: 'Alice', body: 'original' },
    });
    expect(requireTextMessageContent(wire).text).toBe('hello');
  });

  it.each([
    'plain legacy text',
    '{}',
    '{"text":1}',
    '{"text":"hello","quote":null}',
    '{"text":"hello","quote":{"seq":-1}}',
    '{"text":"hello","quote":{"seq":1.5}}',
    '{"text":"hello","quote":{"seq":1,"author":2}}',
  ])('rejects malformed content: %s', (content) => {
    expect(parseTextMessageContent(content)).toBeNull();
    expect(() => requireTextMessageContent(content)).toThrow(
      'invalid PURE_TEXT message envelope',
    );
  });

  it('counts Unicode code points instead of UTF-16 code units', () => {
    const text = '😀'.repeat(TEXT_MESSAGE_MAX_CODE_POINTS);
    expect(text.length).toBe(TEXT_MESSAGE_MAX_CODE_POINTS * 2);
    expect(unicodeCodePointLength(text)).toBe(TEXT_MESSAGE_MAX_CODE_POINTS);
    expect(hasUnpairedSurrogate(text)).toBe(false);
  });

  it('detects unpaired surrogates', () => {
    expect(hasUnpairedSurrogate('\ud800')).toBe(true);
    expect(hasUnpairedSurrogate('\udc00')).toBe(true);
    expect(hasUnpairedSurrogate('valid 😀 text')).toBe(false);
  });
});
