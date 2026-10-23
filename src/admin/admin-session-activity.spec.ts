import { describe, expect, it, vi } from 'vitest';
import { AdminAuthService } from './admin-auth.service.js';

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const row = {
    id: 1n,
    adminId: 2,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 60_000),
    lastAccessedAt: new Date(Date.now() - 6 * 60_000),
    admin: {
      userId: 3,
      enabled: true,
      role: 'ADMIN',
      account: { disabledAt: null, availability: 'AVAILABLE' },
    },
  };
  const findFirst = vi.fn().mockImplementation(async () => ({ ...row }));
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  const update = vi.fn().mockReturnValue({ set });
  const service = new AdminAuthService(
    { db: { query: { adminSession: { findFirst } }, update } } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const entries = () =>
    (service as unknown as { activityWrites: Map<bigint, Promise<void>> })
      .activityWrites;
  return { service, row, findFirst, where, set, update, entries };
}

describe('admin session activity single flight', () => {
  it('coalesces same-session writes but still authenticates each request', async () => {
    const { service, findFirst, where, set, update, entries } = setup();
    const gate = deferred();
    where.mockReturnValue(gate.promise);
    const first = service.validateAdminSession('token', '192.0.2.1');
    const second = service.validateAdminSession('token', '192.0.2.2');
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(findFirst).toHaveBeenCalledTimes(2);
    expect(entries().size).toBe(1);
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ ip: '192.0.2.1' }),
    );
    gate.resolve();
    expect(await first).toMatchObject({ sessionId: 1 });
    expect(await second).toMatchObject({ sessionId: 1 });
    expect(entries().size).toBe(0);
    // No settled-promise cache: a later eligible write may start again.
    await service.validateAdminSession('token', '192.0.2.3');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('cleans up a rejected shared write and permits retry', async () => {
    const { service, where, update, entries } = setup();
    const gate = deferred();
    where.mockReturnValueOnce(gate.promise);
    const results = Promise.allSettled([
      service.validateAdminSession('token'),
      service.validateAdminSession('token'),
    ]);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const failure = new Error('database unavailable');
    gate.reject(failure);
    expect(await results).toEqual([
      { status: 'rejected', reason: failure },
      { status: 'rejected', reason: failure },
    ]);
    expect(entries().size).toBe(0);
    await service.validateAdminSession('token');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('also removes the key on a synchronous database error', async () => {
    const { service, update, entries } = setup();
    update.mockImplementationOnce(() => {
      throw new Error('sync error');
    });
    await expect(service.validateAdminSession('token')).rejects.toThrow(
      'sync error',
    );
    expect(entries().size).toBe(0);
    await service.validateAdminSession('token');
    expect(update).toHaveBeenCalledTimes(2);
  });

  it('does not merge different sessions', async () => {
    const { service, row, findFirst, where, update, entries } = setup();
    const gate = deferred();
    where.mockReturnValue(gate.promise);
    findFirst
      .mockResolvedValueOnce(row)
      .mockResolvedValueOnce({ ...row, id: 2n });
    const pending = Promise.all([
      service.validateAdminSession('a'),
      service.validateAdminSession('b'),
    ]);
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(entries().size).toBe(2);
    gate.resolve();
    await pending;
    expect(entries().size).toBe(0);
  });

  it('retains the five-minute threshold and independently rejects revoked sessions', async () => {
    const { service, row, where, update, entries } = setup();
    row.lastAccessedAt = new Date();
    await service.validateAdminSession('token');
    expect(update).not.toHaveBeenCalled();
    row.lastAccessedAt = new Date(Date.now() - 6 * 60_000);
    const gate = deferred();
    where.mockReturnValue(gate.promise);
    const pending = service.validateAdminSession('token');
    await vi.waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    row.admin.enabled = false;
    expect(await service.validateAdminSession('token')).toBeNull();
    gate.resolve();
    await pending;
    expect(entries().size).toBe(0);
  });
});
