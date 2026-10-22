import { describe, expect, it } from 'vitest';
import { parseIncomingRequestHead, requestIdFromWire } from './relationship-request.js';

describe('request ID wire boundary', () => {
  it('preserves bigint precision and canonical text', () => {
    for (const id of ['1', '9007199254740993', '9223372036854775807'])
      expect(requestIdFromWire(id)).toBe(id);
    expect(requestIdFromWire('0', true)).toBe('0');
  });

  it.each([0, 1, null, undefined, '', '0', '01', '-1', '+1', '1.0', '1e3',
    ' 1', '1 ', '9223372036854775808', '99999999999999999999'])
  ('rejects invalid round ID %j', (value) => {
    expect(() => requestIdFromWire(value)).toThrow();
  });
});

describe('incoming request head', () => {
  it('accepts zero and exact large coordinates', () => {
    expect(parseIncomingRequestHead({ requestEndId: '0', requestReadId: '0' }))
      .toEqual({ requestEndId: '0', requestReadId: '0' });
    expect(parseIncomingRequestHead({
      requestEndId: '9223372036854775807', requestReadId: '9007199254740993',
    })).toEqual({ requestEndId: '9223372036854775807', requestReadId: '9007199254740993' });
  });

  it.each([
    null, [], {}, { requestEndId: '1' },
    { requestEndId: 1, requestReadId: '0' },
    { requestEndId: '1', requestReadId: '2' },
    { requestEndId: '01', requestReadId: '0' },
    { requestEndId: '1', requestReadId: '0', sentEndId: '1' },
  ])('rejects incomplete, malformed, or extended heads %j', (value) => {
    expect(() => parseIncomingRequestHead(value)).toThrow();
  });
});
