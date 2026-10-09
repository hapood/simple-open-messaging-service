import { describe, expect, it } from 'vitest';
import {
  parseMessageContentQuote,
  readMessageContentQuote,
  storedQuoteCoordinate,
  withMessageContentQuote,
  withoutMessageContentQuote,
} from './message-content-quote.js';
import { parseTextMessageContent } from './text-message-content.js';

describe('common message quote envelope', () => {
  it.each([
    { text: 'reply' },
    { url: '/uploads/image', size: 12, w: 4, h: 3 },
    { url: '/uploads/file', size: 12, name: 'file.txt' },
    { items: [{ kind: 'image', url: '/uploads/image', size: 12 }] },
    { bundleId: 'bundle' },
  ])('handles quote independently of payload fields: %j', (payload) => {
    const quote = { seq: 42, namespaceId: 3, digest: 'd'.repeat(64) };
    const content = withMessageContentQuote(JSON.stringify(payload), quote);
    expect(parseMessageContentQuote(content)).toEqual(quote);
    expect(readMessageContentQuote(content)).toEqual(quote);
    expect(JSON.parse(withoutMessageContentQuote(content))).toEqual(payload);
  });

  it('separates text parsing from common quote parsing', () => {
    const content = withMessageContentQuote('{"text":"reply"}', { seq: 42 });
    expect(parseTextMessageContent(content)).toEqual({ text: 'reply' });
    expect(parseMessageContentQuote(content)).toEqual({ seq: 42 });
  });

  it.each([
    null,
    [],
    { seq: -1 },
    { seq: 1.5 },
    { seq: 1, digest: 'bad' },
    { seq: 1, namespaceId: -1 },
    { seq: 1, sourceSeq: 0 },
    { seq: 1, status: 'UNKNOWN' },
  ])('rejects malformed present quote at input boundaries: %j', (quote) => {
    const content = JSON.stringify({ text: 'reply', quote });
    expect(parseMessageContentQuote(content)).toBeUndefined();
    expect(() => readMessageContentQuote(content)).toThrow(
      'invalid message quote',
    );
  });

  it.each(['plain text', '{}', 'null', '[]'])(
    'allows an absent quote: %s',
    (content) => {
      expect(readMessageContentQuote(content)).toBeUndefined();
    },
  );

  it('resolves durable coordinates without consulting the text schema', () => {
    expect(storedQuoteCoordinate({ seq: 42, namespaceId: 3 }, 7)).toEqual({
      seq: 42,
      namespaceId: 3,
    });
    expect(storedQuoteCoordinate({ seq: 0, sourceSeq: 42 }, 7)).toEqual({
      seq: 42,
      namespaceId: 7,
    });
    expect(storedQuoteCoordinate({ seq: 42 }, 7)).toEqual({
      seq: 42,
      namespaceId: 0,
    });
  });
});
