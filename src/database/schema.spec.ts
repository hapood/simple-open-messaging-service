import { readFileSync, readdirSync } from 'node:fs';
import { is, Table } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import * as schema from './schema.js';

const tables = Object.values(schema)
  .filter((value) => is(value, Table))
  .map((table) => getTableConfig(table));
const migrationsDirectory = new URL(
  '../../database/migrations/',
  import.meta.url,
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith('.sql'))
  .sort();
const baseline = readFileSync(
  new URL('0000_base.sql', migrationsDirectory),
  'utf8',
);
const baselineTables = new Map(
  [
    ...baseline.matchAll(
      /CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"([^"]+)" \(\n([\s\S]*?)\n\);/g,
    ),
  ].map((match) => [match[1], match[2]]),
);

describe('common row timestamps', () => {
  it('keeps the rebuilt baseline', () => {
    expect(migrationFiles).toEqual(['0000_base.sql']);
    expect(schema.mediaAsset.meta.getSQLType()).toBe('jsonb');
    expect(baselineTables.get('MediaAsset')).toContain('meta jsonb');
    expect(baseline).toContain("'{thumbnail,digest}'");
  });

  it('creates final client and federation state without compatibility migrations', () => {
    expect(baselineTables.get('FederatedMessageTombstone')).toContain(
      'consumed boolean DEFAULT false NOT NULL',
    );
    const syncState = baselineTables.get('FederationThreadSyncState')!;
    for (const obsolete of [
      'activeGapId',
      'deletionRecoveryThroughSeq',
      'deletionRecoveryMaxMessageSeq',
    ]) {
      expect(syncState).not.toContain(`"${obsolete}"`);
    }
    expect(syncState).not.toContain(
      '"messageProcessedThroughSeq" <= "messageTargetSeq"',
    );
    const attention = baselineTables.get('AccountThreadState')!;
    for (const column of [
      'previewDeletedSeqs',
      'tombstoneVisibleThroughSeq',
      'groupMetaVisibleThroughId',
    ]) {
      expect(attention).toContain(`"${column}"`);
    }
    for (const obsolete of ['tombstoneEndSeq', 'groupMetaFeedEndId']) {
      expect(attention).not.toContain(`"${obsolete}"`);
      expect(baseline).not.toContain(`NEW."${obsolete}"`);
    }
    expect(baselineTables.get('GroupMeta')).toContain(
      '"metaRecoveryThroughId" integer DEFAULT 0 NOT NULL',
    );
    expect(baselineTables.get('GroupMeta')).toContain(
      '"clientMetaEndId" integer DEFAULT 0 NOT NULL',
    );
    expect(baselineTables.get('ClientGroupMetaFeed')).toContain(
      '"ClientGroupMetaFeed_count_check"',
    );
    expect(baselineTables.get('ClientStateFeed')).toContain(
      '"ClientStateFeed_type_thread_check"',
    );
    expect(baseline).toContain(
      '"ClientStateFeed_pkey" PRIMARY KEY ("userId", type, "threadId")',
    );
    expect(baseline).toContain(
      'CREATE TRIGGER "FederationThreadHistoryGap_direction_check"',
    );
    expect(baseline).not.toMatch(/\b(?:ADD|DROP) COLUMN\b/);
    expect(baseline).not.toContain('CREATE OR REPLACE FUNCTION');
  });

  it('requires a message author explicitly without assigning fallback identities', () => {
    expect(schema.message.creatorAccount.notNull).toBe(true);
    expect(schema.message.creatorAccount.hasDefault).toBe(false);
    expect(baselineTables.get('Message')).toContain(
      '"creatorAccount" character varying(31) NOT NULL',
    );
  });

  it('stores only durable outcomes without converting legacy task rows', () => {
    const outcomes = ['PENDING', 'COMPLETED', 'FAILED'];
    expect(schema.uploadSessionStatus.enumValues).toEqual(outcomes);
    expect(schema.fileSyncStatus.enumValues).toEqual(outcomes);
    for (const type of ['UploadSessionStatus', 'FileSyncStatus']) {
      expect(baseline).toContain(
        `CREATE TYPE public."${type}" AS ENUM (\n    'PENDING',\n    'COMPLETED',\n    'FAILED'\n)`,
      );
    }
  });

  it('keeps upload task ownership independent of stage lifetime', () => {
    const config = getTableConfig(schema.uploadSession);
    for (const obsolete of ['clientMessageId', 'uploadId', 'attemptId']) {
      expect(config.columns.map((column) => column.name)).not.toContain(
        obsolete,
      );
      expect(baselineTables.get('UploadSession')).not.toContain(
        `"${obsolete}"`,
      );
    }
    expect(schema.uploadSession.id.getSQLType()).toBe('bigserial');
    expect(
      getTableConfig(schema.message).columns.map((column) => column.name),
    ).toContain('clientMessageId');
    expect(
      getTableConfig(schema.pendingMedia).columns.map((column) => column.name),
    ).toContain('clientMessageId');
    for (const column of [
      schema.uploadSession.pendingMediaId,
      schema.uploadSession.messageId,
    ]) {
      expect(column.getSQLType()).toBe('bigint');
      expect(column.notNull).toBe(false);
      const foreignKey = config.foreignKeys.find((key) =>
        key
          .reference()
          .columns.some((referenced) => referenced.name === column.name),
      );
      expect(foreignKey?.onDelete).toBe('set null');
    }
    expect(baseline).toContain(
      'REFERENCES public."PendingMedia"(id) ON DELETE SET NULL',
    );
    expect(baseline).toContain(
      'REFERENCES public."Message"(id) ON DELETE SET NULL',
    );
    expect(baselineTables.get('UploadSession')).not.toContain(
      '"clientMessageId"',
    );
    const indexNames = config.indexes.map((index) => index.config.name);
    for (const suffix of ['partId', 'position']) {
      expect(indexNames).toContain(
        `UploadSession_pendingMediaId_${suffix}_key`,
      );
      expect(indexNames).not.toContain(
        `UploadSession_clientMessageId_${suffix}_key`,
      );
      expect(baseline).toContain(
        `CREATE UNIQUE INDEX "UploadSession_pendingMediaId_${suffix}_key"`,
      );
    }
    // The unique indexes already cover stage lookup and FK maintenance by their leading column.
    expect(indexNames).not.toContain('UploadSession_pendingMediaId_idx');
  });

  it('requires inbound download ownership without changing nullable upload ownership', () => {
    expect(schema.fileSyncProgress.messageId.notNull).toBe(true);
    expect(schema.fileSyncProgress.messageId.hasDefault).toBe(false);
    const key = getTableConfig(schema.fileSyncProgress).foreignKeys.find(
      (key) =>
        key.reference().columns.some((column) => column.name === 'messageId'),
    );
    expect(key?.onDelete).toBe('restrict');
    expect(baselineTables.get('FileSyncProgress')).toContain(
      '"messageId" bigint NOT NULL',
    );
    expect(baseline).toContain(
      'FOREIGN KEY ("messageId") REFERENCES public."Message"(id) ON DELETE RESTRICT;',
    );
    expect(schema.uploadSession.messageId.notNull).toBe(false);
    expect(schema.uploadSession.pendingMediaId.notNull).toBe(false);
  });

  it('does not mirror file-task failure in temporary media coordination', () => {
    expect(
      getTableConfig(schema.pendingMedia).columns.map((column) => column.name),
    ).not.toContain('anyFailed');
    expect(baselineTables.get('PendingMedia')).not.toContain('"anyFailed"');
    expect(baselineTables.get('PendingMedia')).not.toContain(
      '"dependsOnOriginSeq"',
    );
    expect(
      getTableConfig(schema.pendingMedia).columns.map((column) => column.name),
    ).not.toContain('dependsOnOriginSeq');
  });

  it('keeps high-frequency peer observations out of identity rows', () => {
    const identityColumns = tables
      .find((table) => table.name === 'IdentityNamespace')!
      .columns.map((column) => column.name);
    expect(identityColumns).not.toContain('lastHandshakeAt');
    expect(identityColumns).not.toContain('latestHealthCheck');
    expect(baselineTables.get('FederationFeedState')).toContain(
      '"lastHandshakeAt" timestamp(3) with time zone',
    );
    expect(baselineTables.get('FederationFeedState')).toContain(
      '"latestHealthCheck" jsonb',
    );
  });

  it('stores peer signing-key creation time as non-null epoch milliseconds', () => {
    const column = tables
      .find((table) => table.name === 'IdentityNamespace')!
      .columns.find((column) => column.name === 'signingKeyCreatedAt')!;
    expect(column.notNull).toBe(true);
    expect(column.default).toBeUndefined();
    expect(column.getSQLType()).toBe('bigint');
    expect(baseline).toContain('"signingKeyCreatedAt" bigint NOT NULL');
    expect(baseline).toContain('BETWEEN 1 AND 9007199254740991');
  });
  it('requires an original profile generation time without a local-time default', () => {
    const column = schema.profileTable.generatedAt;
    expect(column.notNull).toBe(true);
    expect(column.default).toBeUndefined();
    expect(column.getSQLType()).toBe('bigint');
    expect(baselineTables.get('Profile')).toContain(
      '"generatedAt" bigint NOT NULL',
    );
    expect(baselineTables.get('Profile')).toContain(
      '"generatedAt" >= 0 AND "generatedAt" <= 9007199254740991',
    );
  });

  it('checks every business table in both schema definitions', () => {
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map((table) => table.name).sort()).toEqual(
      [...baselineTables.keys()].sort(),
    );
  });

  it('uses database time for ordinary updates and conflict updates', () => {
    const db = drizzle.mock();
    const update = db
      .update(schema.systemSetting)
      .set({ value: 'next' })
      .toSQL();
    expect(update.sql).toContain('"updatedAt" = CURRENT_TIMESTAMP');
    expect(update.sql).not.toContain('"createdAt" =');
    const upsert = db
      .insert(schema.systemSetting)
      .values({ key: 'timestamp-test', value: 'initial' })
      .onConflictDoUpdate({
        target: schema.systemSetting.key,
        set: { value: 'next' },
      })
      .toSQL();
    expect(upsert.sql).toContain('"updatedAt" = CURRENT_TIMESTAMP');
  });

  it('removes redundant persisted creation timestamps', () => {
    for (const [table, obsolete] of [
      ['AdminActionLog', 'at'],
      ['LoginCode', 'issuedAt'],
      ['S2SKeyCache', 'fetchedAt'],
    ]) {
      expect(
        tables
          .find((candidate) => candidate.name === table)!
          .columns.map((column) => column.name),
      ).not.toContain(obsolete);
      expect(baselineTables.get(table)).not.toMatch(
        new RegExp(
          `(?:"${obsolete}"|\\b${obsolete}\\b) (?:timestamp|timestamptz)`,
        ),
      );
    }
  });

  for (const table of tables) {
    it(`${table.name} has non-null millisecond timestamp columns in Drizzle and SQL`, () => {
      const sql = baselineTables.get(table.name);
      expect(sql).toBeDefined();
      for (const name of ['createdAt', 'updatedAt']) {
        const column = table.columns.find(
          (candidate) => candidate.name === name,
        );
        expect(column, `${table.name}.${name}`).toBeDefined();
        expect(column!.notNull).toBe(true);
        expect(
          column!.default,
          `${table.name}.${name} insert default`,
        ).toBeDefined();
        if (name === 'updatedAt') {
          expect(column!.onUpdateFn, `${table.name} update hook`).toBeTypeOf(
            'function',
          );
        } else {
          expect(column!.onUpdateFn).toBeUndefined();
        }
        expect(column!.getSQLType()).toBe('timestamp (3) with time zone');
        expect(sql).toMatch(
          new RegExp(
            `"${name}" (?:timestamp\\(3\\) with time zone|timestamptz\\(3\\))[^\\n]*DEFAULT CURRENT_TIMESTAMP[^\\n]*NOT NULL`,
          ),
        );
      }
    });
  }
});
