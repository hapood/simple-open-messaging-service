import { InternalServerErrorException } from '@nestjs/common';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import { AdminAuditInterceptor } from './admin-audit.interceptor.js';

describe('AdminAuditInterceptor', () => {
  const returningInsert = vi.fn();
  const insertValues = vi.fn(() => ({ returning: returningInsert }));
  const insert = vi.fn(() => ({ values: insertValues }));
  const returningUpdate = vi.fn();
  const updateWhere = vi.fn(() => ({ returning: returningUpdate }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));
  const reflector = {
    getAllAndOverride: vi.fn(() => ({
      action: 'user.disable',
      options: { targetType: 'user', targetParam: 'id' },
    })),
  };
  const request = {
    user: { adminId: 7, role: 'SUPER_ADMIN' },
    params: { id: '42' },
    body: { threadId: 99 },
    ip: '192.0.2.1',
    headers: { 'user-agent': 'test-agent' },
    url: '/admin/users/42/disable',
  };
  const context = {
    getHandler: vi.fn(),
    getClass: vi.fn(),
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  let interceptor: AdminAuditInterceptor;

  beforeEach(() => {
    vi.clearAllMocks();
    returningInsert.mockResolvedValue([{ id: 11n }]);
    returningUpdate.mockResolvedValue([{ id: 11n }]);
    interceptor = new AdminAuditInterceptor(
      reflector as unknown as Reflector,
      { db: { insert, update } } as unknown as DatabaseService,
    );
  });

  it('persists STARTED before invoking the action and then marks it SUCCEEDED', async () => {
    let resolveInsert!: (rows: { id: bigint }[]) => void;
    returningInsert.mockReturnValue(
      new Promise((resolve) => {
        resolveInsert = resolve;
      }),
    );
    const next: CallHandler = { handle: vi.fn(() => of('done')) };

    const resultPromise = lastValueFrom(interceptor.intercept(context, next));
    await Promise.resolve();

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'user.disable',
        targetId: '42',
        status: 'STARTED',
      }),
    );
    expect(next.handle).not.toHaveBeenCalled();

    resolveInsert([{ id: 11n }]);
    await expect(resultPromise).resolves.toBe('done');
    expect(next.handle).toHaveBeenCalledOnce();
    expect(updateSet).toHaveBeenCalledWith({
      status: 'SUCCEEDED',
      errorMessage: null,
    });
  });

  it('can resolve the audited target from the request body', async () => {
    reflector.getAllAndOverride.mockReturnValueOnce({
      action: 'thread.history.clear',
      options: { targetType: 'thread', targetBody: 'threadId' },
    });
    const next: CallHandler = { handle: vi.fn(() => of(undefined)) };

    await lastValueFrom(interceptor.intercept(context, next));

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ targetType: 'thread', targetId: '99' }),
    );
  });

  it('refuses the action when the STARTED row cannot be persisted', async () => {
    returningInsert.mockRejectedValue(new Error('database unavailable'));
    const next: CallHandler = { handle: vi.fn(() => of('must not run')) };

    await expect(
      lastValueFrom(interceptor.intercept(context, next)),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(next.handle).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('marks the audit FAILED and preserves the original action error', async () => {
    const actionError = new Error('last super admin');
    const next: CallHandler = {
      handle: vi.fn(() => throwError(() => actionError)),
    };

    await expect(
      lastValueFrom(interceptor.intercept(context, next)),
    ).rejects.toBe(actionError);
    expect(updateSet).toHaveBeenCalledWith({
      status: 'FAILED',
      errorMessage: 'last super admin',
    });
  });

  it('does not change the action result when finalization fails', async () => {
    returningUpdate.mockRejectedValue(new Error('update unavailable'));
    const next: CallHandler = { handle: vi.fn(() => of('done')) };

    await expect(
      lastValueFrom(interceptor.intercept(context, next)),
    ).resolves.toBe('done');
  });
});
