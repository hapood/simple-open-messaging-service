import {
  limitUnicodeCodePoints,
  unicodeCodePointLength,
} from './unicode-text';

describe('unicode text boundaries', () => {
  it('limits surrogate-pair characters by code point', () => {
    const value = limitUnicodeCodePoints('😀'.repeat(40), 31);

    expect(value).toBe('😀'.repeat(31));
    expect(unicodeCodePointLength(value)).toBe(31);
    expect(value.length).toBe(62);
  });

  it('preserves combining sequences as code points without splitting surrogate pairs', () => {
    const value = limitUnicodeCodePoints('e\u0301'.repeat(40), 31);

    expect(unicodeCodePointLength(value)).toBe(31);
    expect(value).toBe(`e\u0301`.repeat(15) + 'e');
  });
});
