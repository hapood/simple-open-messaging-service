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

    expect(constraints.get('ThreadAudience_target_check')).toContain(
      'targetNamespaceId',
    );
    expect(constraints.has('ThreadAudience_accessEpoch_check')).toBe(false);
    expect(constraints.has('ThreadAudience_messageAccessAfterSeq_check')).toBe(
      true,
    );
    expect(constraints.has('ThreadAudience_scope_check')).toBe(false);
    expect(constraints.has('ThreadAudience_deliverThroughChangeId_check')).toBe(
      false,
    );

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
        'deliverThroughChangeId',
        'remoteRelationshipRev',
      ]),
    );
    expect(names).toContain('messageAccessAfterSeq');
    expect(names).not.toContain('messageScannedThroughSeq');

    // FederatedPeer is gone: peer state lives on IdentityNamespace, and the
    // addedBy column was removed with it.
    const peerTable = await database.pool.query<{ exists: boolean }>(
      `SELECT to_regclass('public."FederatedPeer"') IS NOT NULL AS exists`,
    );
    expect(peerTable.rows[0]?.exists).toBe(false);
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

  it('installs State Feed and thread-scoped sync while removing superseded message feeds', async () => {
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
          'FederationMessageFeedIndex',
          'FederationTombstoneFeedIndex',
          'FederationMessageFeedAllocation',
          'FederationTombstoneFeedAllocation',
          'FederationAudienceEpoch',
          'FederationThreadCheckpoint',
          'FederationTombstoneCheckpoint',
          'FederationP2PHistoryGrant',
          'PeerStateFeed',
          'ProfileNamespaceFeed',
          'ProfileNamespaceInfo',
          'FederationThreadSyncState',
        ],
      ],
    );
    expect(tables.rows.map((row) => row.table_name).sort()).toEqual(
      [
        'FederationThreadSyncState',
        'PeerStateFeed',
        'ProfileNamespaceFeed',
      ].sort(),
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

    const cursorConstraints = await database.pool.query<{
      conname: string;
      definition: string;
    }>(
      `SELECT conname, pg_get_constraintdef(oid) AS definition
       FROM pg_constraint
       WHERE conrelid IN (
         '"FederationFeedState"'::regclass,
         '"ProfileNamespaceFeed"'::regclass,
         '"FederationThreadSyncState"'::regclass
       )`,
    );
    const cursorChecks = new Map(
      cursorConstraints.rows.map((row) => [row.conname, row.definition]),
    );
    expect(cursorChecks.get('FederationFeedState_coordinates_check')).toContain(
      'outboundStateFeedEndId',
    );
    expect(cursorChecks.get('FederationFeedState_coordinates_check')).toContain(
      'inboundStateFeedPulledThrough',
    );
    expect(cursorChecks.get('ProfileNamespaceFeed_feedId_check')).toContain(
      'feedId',
    );
    expect(
      cursorChecks.get('FederationThreadSyncState_messageSeqs_check'),
    ).toContain('messageProcessedThroughSeq');

    const obsoleteFunctions = await database.pool.query<{ proname: string }>(
      `SELECT proname
       FROM pg_proc
       JOIN pg_namespace ON pg_namespace.oid = pg_proc.pronamespace
       WHERE pg_namespace.nspname = 'public'
         AND proname = 'soms_sync_federation_tombstone_checkpoint'`,
    );
    expect(obsoleteFunctions.rows).toEqual([]);
  });
});
