import { describe, expect, it, vi } from 'vitest';
import {
  FIXED_WINDOW_DEFAULTS,
  FixedWindowPolicyService,
} from './fixed-window-policy.service.js';

function database(
  rows: Array<{ key: string; value: string; updatedAt?: Date }> = [],
) {
  const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const values = vi.fn(() => ({ onConflictDoUpdate }));
  const insert = vi.fn(() => ({ values }));
  const transaction = vi.fn(async (cb) => cb({ insert }));
  return {
    value: {
      db: {
        query: {
          systemSetting: {
            findMany: vi.fn().mockResolvedValue(
              rows.map((r) => ({
                key: r.key,
                value: r.value,
                updatedAt: r.updatedAt ?? new Date(1000),
              })),
            ),
          },
        },
        transaction,
        insert,
      },
    },
    transaction,
    onConflictDoUpdate,
  };
}

describe('FixedWindowPolicyService', () => {
  it('exposes the existing route limits as defaults', async () => {
    const service = new FixedWindowPolicyService(database().value as never);
    await service.onModuleInit();
    expect(service.get('message.send')).toEqual({
      policy: 'message.send',
      limit: 60,
      windowSeconds: 60,
    });
    expect(service.list()).toHaveLength(
      Object.keys(FIXED_WINDOW_DEFAULTS).length,
    );
  });

  it('persists and immediately applies a complete replacement', async () => {
    const db = database();
    const service = new FixedWindowPolicyService(db.value as never);
    const next = service
      .list()
      .map((policy) =>
        policy.policy === 'message.send' ? { ...policy, limit: 75 } : policy,
      );
    await service.set(next);
    expect(service.get('message.send').limit).toBe(75);
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(db.onConflictDoUpdate).toHaveBeenCalledTimes(
      Object.keys(FIXED_WINDOW_DEFAULTS).length * 2,
    );
  });

  it('falls back to in-memory defaults on missing or corrupted keys', async () => {
    const rows = [
      { key: 'rateLimit:fixedWindow:message.send:limit', value: '120' },
      { key: 'rateLimit:fixedWindow:message.send:windowSeconds', value: 'bad' },
    ];
    const service = new FixedWindowPolicyService(database(rows).value as never);
    await service.onModuleInit();
    expect(service.get('message.send')).toEqual({
      policy: 'message.send',
      limit: 60, // fallen back because windowSeconds was bad
      windowSeconds: 60,
    });
  });

  it('rejects partial and duplicate policy sets', async () => {
    const service = new FixedWindowPolicyService(database().value as never);
    await expect(service.set(service.list().slice(1))).rejects.toThrow(
      'all fixed-window policies are required',
    );
    const duplicate = service.list();
    duplicate[1] = { ...duplicate[1], policy: duplicate[0].policy };
    await expect(service.set(duplicate)).rejects.toThrow(
      'unique and supported',
    );
  });
});
