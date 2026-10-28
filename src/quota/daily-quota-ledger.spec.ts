import { afterEach, describe, expect, it, vi } from 'vitest';
import { DailyQuotaLedger, type QuotaLimits } from './daily-quota-ledger.js';
import { QuotaService } from './quota.service.js';
import { UserQuotaService } from './user-quota.service.js';
import { QuotaPausedError } from './quota-runtime.js';
const limits: QuotaLimits = {
  dailyMsgLimit: 2,
  dailyRequestLimit: 1,
  dailySignalLimit: 401,
  dailyFileLimit: 1,
  dailyFileBytesLimit: 10,
};
function database() {
  return {
    db: {
      query: {
        systemSetting: { findMany: vi.fn().mockResolvedValue([]) },
        federationQuotaPolicy: { findFirst: vi.fn().mockResolvedValue(limits) },
        userQuotaPolicy: { findFirst: vi.fn().mockResolvedValue(limits) },
        account: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ account: 'alice', kind: 'USER' }),
        },
      },
    },
  };
}
afterEach(() => vi.useRealTimers());
describe('process-local daily quotas', () => {
  it('atomically rejects an unaffordable strict charge without consuming it', () => {
    const ledger = new DailyQuotaLedger();
    expect(ledger.charge('a', 'signals', 400n, limits, true)).toBe(true);
    expect(ledger.charge('a', 'signals', 2n, limits, true)).toBe(false);
    expect(ledger.used('a', 'signals')).toBe(400n);
    expect(ledger.charge('a', 'signals', 1n, limits, true)).toBe(true);
    expect(ledger.exhausted('a', 'signals', limits)).toBe(true);
    expect(ledger.used('b', 'signals')).toBe(0n);
  });
  it('resets usage and grants at UTC midnight and on process recreation', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T23:59:59Z'));
    const ledger = new DailyQuotaLedger();
    ledger.charge('a', 'messages', 2n, limits, false);
    ledger.grant('a', 'messages', 5n);
    expect(ledger.limit('a', 'messages', limits)).toBe(7n);
    expect(new DailyQuotaLedger().used('a', 'messages')).toBe(0n);
    vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
    expect(ledger.used('a', 'messages')).toBe(0n);
    expect(ledger.limit('a', 'messages', limits)).toBe(2n);
  });
  it('stops state on either dimension, but calls and file budgets remain independent', async () => {
    const quota = new QuotaService(database() as never);
    await quota.tickLax(7, 'requests');
    await expect(quota.assertCanConsumeState(7)).rejects.toBeInstanceOf(
      QuotaPausedError,
    );
    await expect(quota.assertCanPullMessages(7)).resolves.toBeUndefined();
    await quota.tick(7, 'signals', undefined, 400);
    await quota.addQuota(7, { addRequest: 2 });
    await expect(quota.assertCanConsumeState(7)).resolves.toBeUndefined();
    await quota.tickLax(7, 'messages', undefined, 3);
    await expect(quota.assertCanConsumeState(7)).rejects.toBeInstanceOf(
      QuotaPausedError,
    );
    await expect(quota.assertCanPullMessages(7)).rejects.toBeInstanceOf(
      QuotaPausedError,
    );
  });
  it('permits in-flight soft charges beyond a limit and reports zero remaining', async () => {
    const quota = new QuotaService(database() as never);
    await Promise.all(
      Array.from({ length: 4 }, () => quota.tickLax(7, 'messages')),
    );
    expect((await quota.usageToday(7)).messages).toEqual({
      count: 4,
      limit: 2,
      remaining: 0,
    });
  });
  it('admits a file count and byte charge together without partial debit', async () => {
    const quota = new QuotaService(database() as never);
    await expect(quota.claimFile(7, 1, 11n)).rejects.toThrow();
    expect((await quota.usageToday(7)).files.count).toBe(0);
    const results = await Promise.allSettled([
      quota.claimFile(7, 1, 8n),
      quota.claimFile(7, 1, 8n),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await quota.breakerStatus(7)).fileBytes.bytes).toBe('8');
  });
  it('uses account policies for local callers and preserves scope isolation', async () => {
    const db = database();
    const users = new UserQuotaService(db as never);
    const peers = new QuotaService(db as never);
    await users.tickStandalone(1, 'signals', 400);
    expect((await users.getState(1)).usage.signals.count).toBe(400);
    expect((await users.breakerStatus(1)).entity).toBe('alice');
    expect((await peers.usageToday(1)).signals.count).toBe(0);
    expect(db.db.query.userQuotaPolicy.findFirst).toHaveBeenCalled();
    expect(
      (await new UserQuotaService(db as never).getState(1)).usage.signals.count,
    ).toBe(0);
  });
});
