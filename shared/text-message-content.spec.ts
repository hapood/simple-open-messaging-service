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
  it('round-trips only the text payload', () => {
    const wire = stringifyTextMessageContent({ text: 'hello' });
    expect(parseTextMessageContent(wire)).toEqual({ text: 'hello' });
    expect(requireTextMessageContent(wire).text).toBe('hello');
  });

  it.each([null, { seq: -1 }, { seq: 31, author: 'Alice' }])(
    'leaves quote interpretation to the common envelope parser: %j',
    (quote) => {
      expect(
        parseTextMessageContent(JSON.stringify({ text: 'hello', quote })),
      ).toEqual({ text: 'hello' });
    },
  );

  it.each(['plain legacy text', '{}', '{"text":1}'])(
    'rejects malformed content: %s',
    (content) => {
      expect(parseTextMessageContent(content)).toBeNull();
      expect(() => requireTextMessageContent(content)).toThrow(
        'invalid PURE_TEXT message envelope',
      );
    },
  );

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
