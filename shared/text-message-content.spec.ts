import { describe, expect, it } from 'vitest';
import {
  parseTextMessageContent,
  requireTextMessageContent,
  stringifyTextMessageContent,
} from './text-message-content.js';

describe('text message content protocol', () => {
  it('round-trips text and a server-authored quote', () => {
    const wire = stringifyTextMessageContent({
      text: 'hello',
      quote: { seq: 31, preview: 'Alice：original' },
    });
    expect(parseTextMessageContent(wire)).toEqual({
      text: 'hello',
      quote: { seq: 31, preview: 'Alice：original' },
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
    '{"text":"hello","quote":{"seq":1,"preview":2}}',
  ])('rejects malformed content: %s', (content) => {
    expect(parseTextMessageContent(content)).toBeNull();
    expect(() => requireTextMessageContent(content)).toThrow(
      'invalid PURE_TEXT message envelope',
    );
  });
});
