import 'reflect-metadata';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PgDialect } from 'drizzle-orm/pg-core';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseService } from '../database/database.service.js';
import type { AuditTargetLabelService } from './audit-target-label.service.js';
import { AuditController } from './audit.controller.js';
import { AdminAuthGuard } from './admin-auth.guard.js';
import { AdminAuditDetailDto, AdminAuditQueryDto } from './admin.dto.js';

function queryChain(rows: unknown[]) {
  const chain = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy: vi.fn(),
    offset: vi.fn(),
    limit: vi.fn(),
    then: Promise.resolve(rows).then.bind(Promise.resolve(rows)),
  };
  for (const method of ['from', 'where', 'orderBy', 'offset'] as const)
    chain[method].mockReturnValue(chain);
  chain.limit.mockResolvedValue(rows);
  return chain;
}

describe('AuditController', () => {
  const row = {
    id: 5n,
    action: 'user.disable',
    targetType: 'user',
    targetId: '42',
    meta: {},
  };
  let select: ReturnType<typeof vi.fn>;
  let labels: { resolve: ReturnType<typeof vi.fn> };
  let controller: AuditController;
  beforeEach(() => {
    select = vi.fn();
    labels = {
      resolve: vi.fn().mockResolvedValue(new Map([['user:42', 'alice']])),
    };
    controller = new AuditController(
      { db: { select } } as unknown as DatabaseService,
      labels as unknown as AuditTargetLabelService,
    );
  });

  it('requires admin authentication for every read endpoint without role restrictions', () => {
    for (const method of ['list', 'detail', 'actions'] as const) {
      expect(
        Reflect.getMetadata(GUARDS_METADATA, AuditController.prototype[method]),
      ).toEqual([AdminAuthGuard]);
    }
  });

  it('lists summaries with literal substring and half-open time filters', async () => {
    const records = queryChain([row]);
    const total = queryChain([{ value: 1 }]);
    select.mockReturnValueOnce(records).mockReturnValueOnce(total);
    const result = await controller.list({
      action: 'user_%',
      adminId: 7,
      status: 'SUCCEEDED',
      from: '2026-06-01T00:00:00Z',
      to: '2026-06-02T00:00:00Z',
      skip: 50,
      take: 50,
    });
    expect(result).toEqual({
      list: [{ ...row, targetLabel: 'alice' }],
      total: 1,
    });
    const fields = select.mock.calls[0][0];
    expect(fields).not.toHaveProperty('meta');
    const sql = new PgDialect().sqlToQuery(records.where.mock.calls[0][0]);
    expect(sql.params).toContain('%user\\_\\%%');
    expect(sql.params).toContain(7);
    expect(sql.sql).toContain('>=');
    expect(sql.sql).toContain('<');
    expect(records.orderBy.mock.calls[0]).toHaveLength(2);
    expect(records.offset).toHaveBeenCalledWith(50);
  });

  it('rejects reversed time ranges before querying', async () => {
    await expect(
      controller.list({
        from: '2026-06-02T00:00:00Z',
        to: '2026-06-01T00:00:00Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(select).not.toHaveBeenCalled();
  });

  it('returns operation data and target label in the detail', async () => {
    select.mockReturnValue(queryChain([row]));
    await expect(controller.detail({ id: '5' })).resolves.toEqual({
      ...row,
      targetLabel: 'alice',
    });
  });

  it('rejects IDs beyond PostgreSQL bigint and reports missing records', async () => {
    await expect(
      controller.detail({ id: '9223372036854775808' }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(select).not.toHaveBeenCalled();
    select.mockReturnValue(queryChain([]));
    await expect(controller.detail({ id: '5' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('validates input dates, positive actors, pagination and decimal string IDs', async () => {
    expect(
      await validate(
        plainToInstance(AdminAuditQueryDto, {
          from: 'not-a-date',
          adminId: 0,
          take: 201,
          skip: -1,
        }),
      ),
    ).toHaveLength(4);
    for (const id of ['0', '-1', '1.5', 'abc', '99999999999999999999']) {
      expect(
        (await validate(plainToInstance(AdminAuditDetailDto, { id }))).length,
      ).toBeGreaterThan(0);
    }
    expect(
      await validate(
        plainToInstance(AdminAuditDetailDto, { id: '9223372036854775807' }),
      ),
    ).toEqual([]);
  });
});
