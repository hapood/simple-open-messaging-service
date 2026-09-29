import { describe, expect, it } from 'vitest';
import { parseKeyId } from './key-id.js';

describe('parseKeyId', () => {
  it('parses a canonical KeyId into domain and opaque key name', () => {
    expect(parseKeyId('a.example/k-Ab3xY_z-9')).toEqual({
      domain: 'a.example',
      keyName: 'k-Ab3xY_z-9',
    });
    expect(parseKeyId('a.example/key-1')).toEqual({
      domain: 'a.example',
      keyName: 'key-1',
    });
  });

  it('accepts the full KeyName grammar and longest key names', () => {
    const longName = 'a'.repeat(64);
    expect(parseKeyId(`a.example/${longName}`)?.keyName).toBe(longName);
    expect(parseKeyId('a.example/A.b_c-d')?.keyName).toBe('A.b_c-d');
  });

  it('rejects malformed shapes without normalizing them', () => {
    expect(parseKeyId('')).toBeNull();
    expect(parseKeyId('a.example')).toBeNull();
    expect(parseKeyId('/key-1')).toBeNull();
    expect(parseKeyId('a.example/')).toBeNull();
    // Case folding and whitespace are never applied: invalid stays invalid.
    expect(parseKeyId('A.EXAMPLE/key-1')).toBeNull();
    expect(parseKeyId(' a.example/key-1')).toBeNull();
    expect(parseKeyId('a.example /key-1')).toBeNull();
    expect(parseKeyId('a.example/key 1')).toBeNull();
  });

  it('rejects KeyNames outside the grammar', () => {
    expect(parseKeyId('a.example/' + 'a'.repeat(65))).toBeNull();
    expect(parseKeyId('a.example/key#1')).toBeNull();
    expect(parseKeyId('a.example/key/1')).toBeNull();
    expect(parseKeyId('a.example/key%31')).toBeNull();
  });

  it('rejects non-canonical or reserved domains', () => {
    expect(parseKeyId('local/key-1')).toBeNull();
    expect(parseKeyId('a.local/key-1')).toBeNull();
    expect(parseKeyId('a..example/key-1')).toBeNull();
    expect(parseKeyId('-a.example/key-1')).toBeNull();
    expect(parseKeyId('a.example./key-1')).toBeNull();
  });
});
