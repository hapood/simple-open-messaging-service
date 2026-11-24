import { describe, expect, it } from 'vitest';
import { mediaSource } from './media-source';

const digest = 'a'.repeat(64);
const path = `/uploads/msg-assets/aa/aa/${digest}`;

describe('attachment authorization source', () => {
  it('extracts the carrier coordinates without a display-message fallback', () => {
    expect(mediaSource(`${path}?threadId=7&seq=8`)).toEqual({
      kind: 'message',
      digest,
      threadId: 7,
      seq: 8,
    });
  });

  it.each([
    path,
    `${path}?threadId=7`,
    `${path}?threadId=0&seq=8`,
    `${path}?threadId=7&seq=-2`,
    `${path}?threadId=7&seq=9007199254740992`,
    `${path}?threadId=7&seq=8&seq=9`,
    `/uploads/msg-assets/bb/bb/${digest}?threadId=7&seq=8`,
  ])('rejects malformed managed authorization: %s', (src) => {
    expect(() => mediaSource(src)).toThrow();
  });

  it.each([
    'blob:preview',
    'data:image/png;base64,abc',
    '/uploads/preview.jpg',
  ])('does not invent server coordinates for unmanaged content: %s', (src) => {
    expect(mediaSource(src)).toEqual({ kind: 'unmanaged' });
  });
});
