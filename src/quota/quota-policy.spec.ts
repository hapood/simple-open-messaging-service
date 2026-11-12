import { describe, expect, it, vi } from 'vitest';
import { QuotaService } from './quota.service.js';
import { UserQuotaService } from './user-quota.service.js';
import {
  DEFAULT_MAX_FILE_BYTES,
  normalizeOverrides,
  validateLimits,
} from './quota-policy.js';
import { BusinessCode } from '../common/business-code.js';

function setup(scope: 'peer' | 'user') {
  let policy: { maxFileBytes?: bigint | null } = {};
  const findFirst = vi.fn(async () => policy);
  const db = {
    db: {
      query: {
        federationQuotaPolicy: { findFirst },
        userQuotaPolicy: { findFirst },
        account: {
          findFirst: vi
            .fn()
            .mockResolvedValue({ account: 'alice', kind: 'USER' }),
        },
        systemSetting: { findMany: vi.fn().mockResolvedValue([]) },
      },
    },
  };
  const quota =
    scope === 'peer'
      ? new QuotaService(db as never)
      : new UserQuotaService(db as never);
  return {
    quota,
    policy: (value: typeof policy) => {
      policy = value;
    },
  };
}

describe.each(['peer', 'user'] as const)('%s attachment policy', (scope) => {
  it('inherits the inclusive 1 GiB default and accepts an explicit larger limit', async () => {
    const { quota, policy } = setup(scope);
    await expect(quota.assertFileSize(1, DEFAULT_MAX_FILE_BYTES)).resolves.toBe(
      DEFAULT_MAX_FILE_BYTES,
    );
    await expect(
      quota.assertFileSize(1, DEFAULT_MAX_FILE_BYTES + 1),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FILE_TOO_LARGE,
      data: {
        maxFileBytes: DEFAULT_MAX_FILE_BYTES,
        declaredBytes: DEFAULT_MAX_FILE_BYTES + 1,
      },
    });
    policy({ maxFileBytes: 2n * BigInt(DEFAULT_MAX_FILE_BYTES) });
    await expect(
      quota.assertFileSize(1, DEFAULT_MAX_FILE_BYTES + 1),
    ).resolves.toBe(2 * DEFAULT_MAX_FILE_BYTES);
    policy({ maxFileBytes: null });
    expect(await quota.fileSizeLimit(1)).toBe(DEFAULT_MAX_FILE_BYTES);
  });
  it('zero disables new files, without pausing daily dimensions or consuming quota', async () => {
    const { quota, policy } = setup(scope);
    policy({ maxFileBytes: 0n });
    await expect(quota.assertFileSize(1, 1)).rejects.toMatchObject({
      bizCode: BusinessCode.FILE_TOO_LARGE,
    });
    expect((await quota.breakerStatus(1)).tripped).toBe(false);
    expect((await quota.usageToday(1)).files.count).toBe(0);
    await quota.addQuota(1, { addFileBytes: 100n });
    expect(await quota.fileSizeLimit(1)).toBe(0);
  });
  it('retains the admission charge after failure and does not debit size preflight', async () => {
    const { quota, policy } = setup(scope);
    policy({ maxFileBytes: 20n });
    await quota.assertFileSize(1, 20);
    await quota.claimFile(1, 1, 20n);
    // A transport failure never refunds the admitted work.
    expect((await quota.breakerStatus(1)).fileBytes.bytes).toBe('20');
    await expect(quota.assertFileSize(1, 21)).rejects.toThrow();
    expect((await quota.usageToday(1)).files.count).toBe(1);
    expect((await quota.breakerStatus(1)).fileBytes.bytes).toBe('20');
  });
});

describe('attachment policy validation', () => {
  it('rejects unsafe or negative overrides', () => {
    expect(() => normalizeOverrides({ maxFileBytes: -1n })).toThrow();
    expect(() =>
      normalizeOverrides({ maxFileBytes: 9007199254740992n }),
    ).toThrow();
    expect(normalizeOverrides({ maxFileBytes: 0n }).maxFileBytes).toBe(0n);
    expect(normalizeOverrides({}).maxFileBytes).toBeNull();
  });
  it('requires a complete global policy, separate from daily ledger dimensions', () => {
    const { quota } = setup('peer');
    expect(validateLimits(quota.getDefaultLimits()).maxFileBytes).toBe(
      DEFAULT_MAX_FILE_BYTES,
    );
    expect(() =>
      validateLimits({ ...quota.getDefaultLimits(), maxFileBytes: 1.5 }),
    ).toThrow();
  });
});
