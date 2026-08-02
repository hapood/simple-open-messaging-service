import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BruteForceService,
  BAN_DIM_IP,
  BAN_DIM_USER,
  BAN_DIM_OTP,
  type BanStep,
} from './brute-force.service.js';

// Spans mirror brute-force.service.ts (the values are not exported — the tests assert behavior at these
// windows, so a local copy keeps the assertions readable; if the source windows change, update both).
const WINDOW_MS = 15 * 60 * 1000;

/**
 * BruteForceService: the shared sliding-window + progressive-ban engine behind every login method.
 * Fake timers anchor a fixed clock so tier math, sliding-window expiry, and ban expiry are deterministic.
 * Covers: progressive tiers, multi-dimension isolation, success-clears-counter, the admin listBans parse,
 * unban semantics (account → every account dimension; ip → ip only), and the sliding-window ageing.
 */
describe('BruteForceService', () => {
  let svc: BruteForceService;
  const base = 1_700_000_000_000; // fake-clock anchor (a fixed epoch)

  beforeEach(() => {
    vi.useFakeTimers({ now: base });
    svc = new BruteForceService();
  });
  afterEach(() => {
    svc.onModuleDestroy();
    vi.useRealTimers();
  });

  // The password-login account tiers (mirrors LocalStrategy's RULES.user) — ascending, highest wins.
  const steps: readonly BanStep[] = [
    { count: 5, banMs: 30 * 60 * 1000 },
    { count: 10, banMs: 3 * 60 * 60 * 1000 },
    { count: 20, banMs: 24 * 60 * 60 * 1000 },
  ];

  describe('registerFailure', () => {
    it('bans nothing while the within-window count stays under the first tier', () => {
      for (let i = 0; i < 5; i++) {
        expect(
          svc.registerFailure(BAN_DIM_USER, 'alice', steps),
        ).toBeUndefined();
      }
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_USER, value: 'alice' }]),
      ).toBeUndefined();
    });

    it('returns the ban deadline and stores the ban the instant a tier is crossed', () => {
      for (let i = 0; i < 5; i++)
        svc.registerFailure(BAN_DIM_USER, 'alice', steps);
      const ban = svc.registerFailure(BAN_DIM_USER, 'alice', steps); // 6th → crosses count:5
      expect(ban).toBe(base + 30 * 60 * 1000);
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_USER, value: 'alice' }]),
      ).toBe(ban);
    });

    it('escalates through the ascending tiers (30min → 3h → 24h)', () => {
      for (let i = 0; i < 5; i++)
        svc.registerFailure(BAN_DIM_USER, 'alice', steps);
      expect(svc.registerFailure(BAN_DIM_USER, 'alice', steps)).toBe(
        base + 30 * 60 * 1000,
      ); // 6th
      for (let i = 0; i < 4; i++)
        svc.registerFailure(BAN_DIM_USER, 'alice', steps);
      expect(svc.registerFailure(BAN_DIM_USER, 'alice', steps)).toBe(
        base + 3 * 60 * 60 * 1000,
      ); // 11th
      for (let i = 0; i < 9; i++)
        svc.registerFailure(BAN_DIM_USER, 'alice', steps);
      expect(svc.registerFailure(BAN_DIM_USER, 'alice', steps)).toBe(
        base + 24 * 60 * 60 * 1000,
      ); // 21st
    });
  });

  describe('dimension isolation', () => {
    it('keeps dimensions independent: the same value under different namespaces never collides', () => {
      for (let i = 0; i < 6; i++)
        svc.registerFailure(BAN_DIM_USER, 'alice', steps); // bans user:alice
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_USER, value: 'alice' }]),
      ).toBeDefined();
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_IP, value: 'alice' }]),
      ).toBeUndefined();
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_OTP, value: 'alice' }]),
      ).toBeUndefined();
    });

    it('activeBanUntil returns the latest deadline across the given keys', () => {
      svc.registerFailure(BAN_DIM_IP, '1.2.3.4', [{ count: 0, banMs: 10_000 }]); // ban +10s
      svc.registerFailure(BAN_DIM_USER, 'alice', [{ count: 0, banMs: 60_000 }]); // ban +60s
      expect(
        svc.activeBanUntil([
          { dimension: BAN_DIM_IP, value: '1.2.3.4' },
          { dimension: BAN_DIM_USER, value: 'alice' },
        ]),
      ).toBe(base + 60_000);
    });

    it('activeBanUntil is undefined when none of the keys are banned', () => {
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_IP, value: '9.9.9.9' }]),
      ).toBeUndefined();
    });
  });

  describe('clearFailures (a successful auth restarts the counter)', () => {
    it('clears one dimension so subsequent failures count from zero again', () => {
      for (let i = 0; i < 4; i++)
        svc.registerFailure(BAN_DIM_USER, 'alice', steps); // one short of the tier
      svc.clearFailures(BAN_DIM_USER, 'alice');
      for (let i = 0; i < 5; i++) {
        // 5 fresh failures after the clear → count 5, still under the >5 tier → no ban.
        expect(
          svc.registerFailure(BAN_DIM_USER, 'alice', steps),
        ).toBeUndefined();
      }
    });
  });

  describe('listBans', () => {
    it('lists every in-effect ban with parsed dimension/value and a stable key', () => {
      svc.registerFailure(BAN_DIM_IP, '1.2.3.4', [{ count: 0, banMs: 10_000 }]);
      svc.registerFailure(BAN_DIM_OTP, 'bob', [{ count: 0, banMs: 30_000 }]);
      const bans = svc.listBans();
      expect(bans).toHaveLength(2);
      expect(bans.find((b) => b.type === BAN_DIM_IP)).toMatchObject({
        key: 'ip:1.2.3.4',
        type: 'ip',
        value: '1.2.3.4',
        until: base + 10_000,
        remainingMs: 10_000,
      });
      expect(bans.find((b) => b.type === BAN_DIM_OTP)).toMatchObject({
        key: 'otp:bob',
        type: 'otp',
        value: 'bob',
        until: base + 30_000,
        remainingMs: 30_000,
      });
    });

    it('excludes expired bans (lazy reclaim)', () => {
      svc.registerFailure(BAN_DIM_IP, '1.2.3.4', [{ count: 0, banMs: 10_000 }]);
      vi.advanceTimersByTime(11_000); // past the deadline
      expect(svc.listBans()).toHaveLength(0);
    });
  });

  describe('unban', () => {
    it('clears EVERY account-keyed dimension (password + OTP) for an account, leaving the IP ban', () => {
      svc.registerFailure(BAN_DIM_IP, '1.2.3.4', [{ count: 0, banMs: 60_000 }]);
      svc.registerFailure(BAN_DIM_USER, 'alice', [{ count: 0, banMs: 60_000 }]);
      svc.registerFailure(BAN_DIM_OTP, 'alice', [{ count: 0, banMs: 60_000 }]);
      svc.unban({ account: 'alice' });
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_USER, value: 'alice' }]),
      ).toBeUndefined();
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_OTP, value: 'alice' }]),
      ).toBeUndefined();
      // The IP ban (different dimension, different value) is untouched.
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_IP, value: '1.2.3.4' }]),
      ).toBeDefined();
    });

    it('clears only the IP dimension for an IP unban', () => {
      svc.registerFailure(BAN_DIM_IP, '1.2.3.4', [{ count: 0, banMs: 60_000 }]);
      svc.registerFailure(BAN_DIM_USER, 'alice', [{ count: 0, banMs: 60_000 }]);
      svc.unban({ ip: '1.2.3.4' });
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_IP, value: '1.2.3.4' }]),
      ).toBeUndefined();
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_USER, value: 'alice' }]),
      ).toBeDefined();
    });

    it('also drops the failure log so the within-window count restarts', () => {
      for (let i = 0; i < 5; i++)
        svc.registerFailure(BAN_DIM_OTP, 'alice', steps); // one short of the tier
      svc.unban({ account: 'alice' });
      for (let i = 0; i < 5; i++) {
        expect(
          svc.registerFailure(BAN_DIM_OTP, 'alice', steps),
        ).toBeUndefined();
      }
    });
  });

  describe('sliding window + expiry', () => {
    it('ages out failures older than the window so they stop counting', () => {
      svc.registerFailure(BAN_DIM_OTP, 'alice', steps); // t = base
      vi.advanceTimersByTime(WINDOW_MS + 1); // that failure is now outside the window
      for (let i = 0; i < 5; i++) {
        // The aged failure is filtered → each of these is a fresh count, never crossing the tier.
        expect(
          svc.registerFailure(BAN_DIM_OTP, 'alice', steps),
        ).toBeUndefined();
      }
    });

    it('reclaims an expired ban (activeBanUntil returns undefined past the deadline)', () => {
      svc.registerFailure(BAN_DIM_OTP, 'alice', [{ count: 0, banMs: 30_000 }]);
      vi.advanceTimersByTime(31_000);
      expect(
        svc.activeBanUntil([{ dimension: BAN_DIM_OTP, value: 'alice' }]),
      ).toBeUndefined();
    });
  });
});
