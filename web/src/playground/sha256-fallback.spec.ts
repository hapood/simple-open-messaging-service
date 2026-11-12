import { describe, expect, it } from 'vitest';
import { sha256, sha256Bytes } from './sha256-fallback';

/** FIPS 180-4 / NIST example vectors. */
const vectors: ReadonlyArray<[string, string]> = [
  ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  [
    'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  ],
  [
    'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu',
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  ],
];

const bytes = (text: string): Uint8Array<ArrayBuffer> =>
  new Uint8Array(new TextEncoder().encode(text));

describe('playground sha256 fallback', () => {
  it.each(vectors)('digests %j to the NIST vector', (input, expected) => {
    expect(sha256Bytes(bytes(input))).toBe(expected);
  });

  it('handles minimal and maximal single-block paddings', () => {
    // 55 bytes: 0x80 fills to 56; the length ends the single block.
    expect(sha256Bytes(bytes('a'.repeat(55)))).toBe(
      '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    );
    // 56 bytes: 0x80 spills into a second block (maximum padding edge).
    expect(sha256Bytes(bytes('a'.repeat(56)))).toBe(
      'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    );
    // 64 bytes: exactly one full message block plus a padding-only block.
    expect(sha256Bytes(bytes('a'.repeat(64)))).toBe(
      'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    );
  });

  it('agrees with WebCrypto so secure contexts keep identical digests', async () => {
    const subtle = globalThis.crypto?.subtle;
    if (!subtle) return;
    const data = bytes('playground avatar digest check');
    const expected = Array.from(
      new Uint8Array(await subtle.digest('SHA-256', data)),
      (b) => b.toString(16).padStart(2, '0'),
    ).join('');
    expect(sha256Bytes(data)).toBe(expected);
    expect(await sha256(data)).toBe(expected);
  });
});
