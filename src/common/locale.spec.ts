import { describe, it, expect } from 'vitest';
import {
  parseAcceptLanguage,
  pickLocale,
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
} from './locale.js';

describe('parseAcceptLanguage', () => {
  it('parses a q-weighted list, sorted most-preferred first', () => {
    const out = parseAcceptLanguage('zh-CN,zh;q=0.9,en;q=0.8');
    expect(out.map((e) => e.tag)).toEqual(['zh-cn', 'zh', 'en']);
    expect(out[0]).toEqual({ tag: 'zh-cn', q: 1 });
    expect(out[1]).toEqual({ tag: 'zh', q: 0.9 });
    expect(out[2]).toEqual({ tag: 'en', q: 0.8 });
  });

  it('defaults q to 1 when absent', () => {
    expect(parseAcceptLanguage('en')).toEqual([{ tag: 'en', q: 1 }]);
  });

  it('lowercases + trims whitespace', () => {
    expect(parseAcceptLanguage('  EN-US ; q=0.5 ')).toEqual([{ tag: 'en-us', q: 0.5 }]);
  });

  it('empty / null / undefined → []', () => {
    expect(parseAcceptLanguage('')).toEqual([]);
    expect(parseAcceptLanguage(undefined)).toEqual([]);
    expect(parseAcceptLanguage(null)).toEqual([]);
  });

  it('drops malformed entries without throwing', () => {
    expect(parseAcceptLanguage('en, ;;; ,zh')).toEqual([
      { tag: 'en', q: 1 },
      { tag: 'zh', q: 1 },
    ]);
  });

  it('caps a pathologically long header', () => {
    const huge = Array.from({ length: 5000 }, () => 'en;q=0.1').join(',');
    expect(parseAcceptLanguage(huge).length).toBeLessThanOrEqual(50);
  });
});

describe('pickLocale', () => {
  it('prefers the highest-q supported match', () => {
    expect(pickLocale('zh-CN,zh;q=0.9,en;q=0.8')).toBe('zh-CN');
    expect(pickLocale('fr,en;q=0.9,zh;q=0.8')).toBe('en');
  });

  it('prefix-matches: bare "zh" → zh-CN (no region needed)', () => {
    expect(pickLocale('zh')).toBe('zh-CN');
    expect(pickLocale('zh-TW')).toBe('zh-CN');
    expect(pickLocale('en-GB')).toBe('en');
  });

  it('falls back to the default when nothing matches', () => {
    expect(pickLocale('fr-FR,de;q=0.9')).toBe(DEFAULT_LOCALE);
    expect(pickLocale(undefined)).toBe(DEFAULT_LOCALE);
    expect(pickLocale('')).toBe(DEFAULT_LOCALE);
  });

  it('DEFAULT_LOCALE is in SUPPORTED_LOCALES', () => {
    expect(SUPPORTED_LOCALES).toContain(DEFAULT_LOCALE);
  });
});
