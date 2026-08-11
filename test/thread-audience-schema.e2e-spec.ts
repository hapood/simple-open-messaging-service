import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';

describe('ThreadAudience schema', () => {
  let database: DatabaseService;
  let mod: TestingModule;

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  afterAll(async () => {
    await mod.close();
  });

  it('installs only the current-access target constraint', async () => {
    const result = await database.pool.query<{
      conname: string;
      definition: string;
    }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid = '"ThreadAudience"'::regclass`,
    );
    const constraints = new Map(
      result.rows.map((row) => [row.conname, row.definition]),
    );

    expect(constraints.get('ThreadAudience_target_check')).toContain('local');
    expect(constraints.get('ThreadAudience_target_check')).toContain('<>');
    expect(constraints.has('ThreadAudience_accessEpoch_check')).toBe(false);
    expect(constraints.has('ThreadAudience_visibleRange_check')).toBe(false);
    expect(constraints.has('ThreadAudience_scope_check')).toBe(false);
    expect(
      constraints.get('ThreadAudience_deliverThroughChangeId_check'),
    ).toContain('>= 0');

    const columns = await database.pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'ThreadAudience'`,
    );
    const names = columns.rows.map((row) => row.column_name);
    expect(names).not.toEqual(
      expect.arrayContaining([
        'accessEpoch',
        'startAfterOriginSeq',
        'visibleThroughOriginSeq',
        'endedAt',
        'scope',
        'creatorUserId',
      ]),
    );
  });

  it('installs both audience lookup paths and the message-id join index', async () => {
    const result = await database.pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE indexname = ANY($1::text[])`,
      [
        [
          'ThreadAudience_local_key',
          'ThreadAudience_peer_key',
          'ThreadAudience_local_access_idx',
          'ThreadAudience_peer_access_idx',
          'Message_threadId_id_idx',
        ],
      ],
    );

    expect(result.rows.map((row) => row.indexname).sort()).toEqual(
      [
        'ThreadAudience_local_key',
        'ThreadAudience_peer_key',
        'ThreadAudience_local_access_idx',
        'ThreadAudience_peer_access_idx',
        'Message_threadId_id_idx',
      ].sort(),
    );
  });

  it('installs cursor-only federation allocation and removes database change queues', async () => {
    const tables = await database.pool.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name = ANY($1::text[])`,
      [
        [
          'DiscoveryTarget',
          'DiscoveryChange',
          'FederationPullCursor',
          'FederationServeCursor',
        ],
      ],
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual(
      ['FederationPullCursor', 'FederationServeCursor'].sort(),
    );

    const indexes = await database.pool.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE indexname = ANY($1::text[])`,
      [
        [
          'DiscoveryTarget_local_key',
          'DiscoveryTarget_peer_key',
          'DiscoveryChange_pkey',
          'DiscoveryChange_target_message_key',
          'DiscoveryChange_audience_idx',
          'FederationServeCursor_targetId_key',
        ],
      ],
    );
    expect(indexes.rows).toEqual([]);

    const targetColumns = await database.pool.query<{ column_name: string }>(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_name = 'FederationServeCursor'`,
    );
    const targetColumnNames = targetColumns.rows.map((row) => row.column_name);
    expect(targetColumnNames).toContain('allocatedThrough');
    expect(targetColumnNames).not.toContain('targetId');

    const cursorConstraints = await database.pool.query<{
      conname: string;
      definition: string;
    }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid IN (
         '"FederationPullCursor"'::regclass,
         '"FederationServeCursor"'::regclass
       )`,
    );
    const cursorChecks = new Map(
      cursorConstraints.rows.map((row) => [row.conname, row.definition]),
    );
    expect(cursorChecks.get('FederationPullCursor_remoteHwm_check')).toContain(
      'startChangeId',
    );
    expect(
      cursorChecks.get('FederationServeCursor_acknowledgedThrough_check'),
    ).toContain('startChangeId');
    expect(
      cursorChecks.get('FederationServeCursor_lastServedThrough_check'),
    ).toContain('acknowledgedThrough');
  });
});
