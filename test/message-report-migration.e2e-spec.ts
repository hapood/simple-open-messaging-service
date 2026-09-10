import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';

describe('message report migration', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });
  afterAll(async () => mod.close());

  it('merges per-reporter history and preserves active and dismissed messages', async () => {
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('CREATE SCHEMA report_migration_fixture');
      await client.query('SET LOCAL search_path TO report_migration_fixture');
      await client.query(`
        CREATE TYPE "MessageReportStatus" AS ENUM ('PENDING', 'UPHELD', 'REJECTED');
        CREATE TABLE "MessageThread" (id integer PRIMARY KEY);
        CREATE TABLE "Message" (id bigint PRIMARY KEY, "threadId" integer, seq integer, "isDeleted" boolean,
          UNIQUE ("threadId", seq));
        CREATE TABLE "MessageReport" (
          id bigserial PRIMARY KEY, "messageId" bigint REFERENCES "Message" (id),
          "threadId" integer CONSTRAINT "MessageReport_threadId_fkey" REFERENCES "MessageThread" (id),
          "messageSeq" integer, "reporterId" integer,
          status "MessageReportStatus", "reviewedByAdminId" integer, "reviewedAt" timestamptz,
          "createdAt" timestamptz, "updatedAt" timestamptz
        );
        INSERT INTO "MessageThread" VALUES (7);
        INSERT INTO "Message" VALUES (1, 7, 1, false), (2, 7, 2, false), (3, 7, 3, true);
        INSERT INTO "MessageReport" ("messageId", "threadId", "messageSeq", "reporterId", status, "createdAt", "updatedAt")
        VALUES (1, 7, 1, 1, 'REJECTED', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
               (1, 7, 1, 2, 'PENDING', '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z'),
               (2, 7, 2, 1, 'REJECTED', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
               (3, 7, 3, 1, 'PENDING', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
               (3, 7, 3, 2, 'UPHELD', '2026-02-01T00:00:00Z', '2026-02-02T00:00:00Z');
      `);
      await client.query(
        await readFile('database/migrations/0010_message_reports.sql', 'utf8'),
      );
      const { rows } = await client.query(
        'SELECT * FROM "MessageReport" ORDER BY seq',
      );
      expect(rows).toHaveLength(3);
      expect(rows.map(({ seq, isDeleted }) => ({ seq, isDeleted }))).toEqual([
        { seq: 1, isDeleted: false },
        { seq: 2, isDeleted: true },
        { seq: 3, isDeleted: true },
      ]);
      expect(rows[0].createdAt).toEqual(new Date('2026-01-01T00:00:00Z'));
      expect(rows[0].updatedAt).toEqual(new Date('2026-02-02T00:00:00Z'));
      expect(Object.keys(rows[0]).sort()).toEqual([
        'createdAt',
        'isDeleted',
        'seq',
        'threadId',
        'updatedAt',
      ]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
