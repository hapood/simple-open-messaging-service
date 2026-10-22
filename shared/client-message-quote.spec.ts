import { describe, expect, it } from 'vitest';
import { parseClientMessageQuote } from './client-message-quote.js';

describe('client quote coordinates', () => {
  it.each([{ text: 'reply' }, { url: '/file', size: 12 }, { items: [] }])(
    'reads origin coordinates independently of body fields: %j',
    (payload) => {
      expect(
        parseClientMessageQuote(
          JSON.stringify({
            ...payload,
            quote: { namespaceId: 3, originSeq: 4 },
          }),
        ),
      ).toEqual({ namespaceId: 3, originSeq: 4 });
    },
  );
  it.each([
    null,
    { seq: 4 },
    { namespaceId: -1, originSeq: 4 },
    { namespaceId: 3, originSeq: 0 },
  ])(
    'does not treat malformed or local sequence fields as origin coordinates: %j',
    (quote) => {
      expect(
        parseClientMessageQuote(JSON.stringify({ quote })),
      ).toBeUndefined();
    },
  );
});
