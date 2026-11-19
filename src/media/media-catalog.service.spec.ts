import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { MediaCatalogService } from './media-catalog.service.js';

async function fixture() {
  const response = {
    total: 1,
    list: [
      {
        batchId: 'batch',
        bytesTotal: '8',
        bytesReceived: '8',
        completedFiles: 1,
      },
    ],
  };
  const execute = vi.fn(async (_query: SQL) => ({ rows: [response] }));
  const module = await Test.createTestingModule({
    providers: [
      MediaCatalogService,
      { provide: DatabaseService, useValue: { db: { execute } } },
    ],
  }).compile();
  onTestFinished(() => module.close());
  return { service: module.get(MediaCatalogService), execute, response };
}

describe('media catalog retained download totals', () => {
  it('reads completion, file count, bytes and update time from file tasks', async () => {
    const { service, execute, response } = await fixture();
    expect(await service.batches({ status: 'ready' })).toEqual(response);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain("f.status = 'COMPLETED'");
    expect(query.sql).toContain('sum(f."bytesTotal")');
    expect(query.sql).toContain('sum(f."bytesReceived")');
    expect(query.sql).toContain('count(*)::int AS "totalFiles"');
    expect(query.sql).toContain('max(f."updatedAt")');
    expect(query.sql).not.toContain('p."fileCnt"');
    expect(query.params).toContain('ready');
  });

  it('derives stopped and failed presentation from file outcomes, not batch mirrors', async () => {
    const { service, execute } = await fixture();
    await service.batches({ status: 'stopped', userId: 7, take: 20, skip: 40 });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    const filtered = query.sql.slice(
      query.sql.indexOf('filtered AS MATERIALIZED'),
      query.sql.indexOf('), page AS'),
    );
    expect(filtered).toContain('f.status');
    expect(filtered).not.toContain('p.status');
    expect(query.sql).toContain('f."errorKind" = \'USER_STOPPED\'');
    expect(query.sql).toContain("bool_or(f.status = 'FAILED') THEN 'failed'");
    expect(query.sql).toContain(
      "bool_and(f.status = 'COMPLETED') THEN 'ready'",
    );
    expect(query.sql).not.toContain("THEN 'downloading'");
    expect(query.sql).toContain('SELECT digest, status, "errorKind"');
    expect(query.params).toEqual(['stopped', 'stopped', 7, 7, 20, 40]);
  });
});
