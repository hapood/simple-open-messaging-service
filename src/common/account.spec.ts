import { describe, it, expect } from 'vitest';
import { Prisma } from '../prisma/generated/client.js';
import {
  USER_ACCOUNT_RE,
  GROUP_ACCOUNT_RE,
  normalizeAccount,
  isValidUserAccount,
  isValidGroupAccount,
  isValidAccount,
  isGroupAccount,
  mintUlid,
  mintGroupAccount,
  isP2002,
} from './account.js';

describe('account grammar + minting (docs/account-naming.md)', () => {
  describe('USER_ACCOUNT_RE', () => {
    it.each(['alice', 'john.smith', 'a.b.c', 'ALICE', 'Alice.Bob'])('accepts %s', (v) => {
      expect(isValidUserAccount(v)).toBe(true);
    });
    it.each([
      'a', // too short (< 3)
      'al', // too short
      'alice.bob.charlie.delta.echo.foxtrot.golf.hotel.india', // too long (> 31)
      'alice.', // trailing dot
      '.alice', // leading dot
      'alice..bob', // consecutive dots
      'alice1', // digit
      'alice_', // underscore
      'alice-bob', // hyphen
      'al ice', // space
      'alice@bob', // @ separator
      '!alice', // sigil
      '', // empty
    ])('rejects %s', (v) => {
      expect(isValidUserAccount(v)).toBe(false);
    });
  });

  describe('GROUP_ACCOUNT_RE', () => {
    it('accepts a !-prefixed ULID-shaped id', () => {
      expect(isValidGroupAccount('!' + '0'.repeat(26))).toBe(true);
      expect(isValidGroupAccount('!ab')).toBe(true);
    });
    it.each(['ab', '!', '!!ab', 'alice', '!a', '!' + '0'.repeat(31), '!ab_cd', '!a-b'])(
      'rejects %s',
      (v) => {
        expect(isValidGroupAccount(v)).toBe(false);
      },
    );
  });

  it('isValidAccount accepts either grammar', () => {
    expect(isValidAccount('alice')).toBe(true);
    expect(isValidAccount('!' + '0'.repeat(26))).toBe(true);
    expect(isValidAccount('alice_')).toBe(false);
    expect(isValidAccount('')).toBe(false);
  });

  it('normalizeAccount lowercases', () => {
    expect(normalizeAccount('ALICE')).toBe('alice');
    expect(normalizeAccount('Alice.Bob')).toBe('alice.bob');
    expect(normalizeAccount('!01HZ')).toBe('!01hz');
  });

  it('isGroupAccount discriminates by the sigil', () => {
    expect(isGroupAccount('!01hz')).toBe(true);
    expect(isGroupAccount('alice')).toBe(false);
  });

  describe('ULID minting (CSPRNG)', () => {
    it('mintUlid is 26 lowercase base32 chars', () => {
      const id = mintUlid();
      expect(id).toMatch(/^[0-9a-z]{26}$/);
      expect(id).toBe(id.toLowerCase());
    });
    it('two mintUlid calls differ', () => {
      expect(mintUlid()).not.toBe(mintUlid());
    });
    it('mintGroupAccount is "!" + 26 chars', () => {
      const g = mintGroupAccount();
      expect(g).toMatch(/^![0-9a-z]{26}$/);
      expect(g.length).toBe(27);
      expect(isGroupAccount(g)).toBe(true);
      // body alone is a valid (non-sigil) shape but not a valid USER account (no letters-only rule met by digits)
      expect(g.slice(1)).toMatch(/^[0-9a-z]{26}$/);
    });
    it('two mintGroupAccount calls differ', () => {
      expect(mintGroupAccount()).not.toBe(mintGroupAccount());
    });
  });

  it('isP2002 detects Prisma unique-constraint violations only', () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: '0.0.0',
    });
    expect(isP2002(p2002)).toBe(true);
    const other = new Prisma.PrismaClientKnownRequestError('missing', {
      code: 'P2025',
      clientVersion: '0.0.0',
    });
    expect(isP2002(other)).toBe(false);
    expect(isP2002(new Error('boom'))).toBe(false);
    expect(isP2002(undefined)).toBe(false);
  });

  // sanity: the exported regexes are the same objects the validators use
  it('exports the regexes', () => {
    expect(USER_ACCOUNT_RE.test('alice')).toBe(true);
    expect(GROUP_ACCOUNT_RE.test('!ab')).toBe(true);
  });
});
