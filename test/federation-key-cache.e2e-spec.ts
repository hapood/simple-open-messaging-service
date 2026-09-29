import { createHash } from 'node:crypto';
import { Test, type TestingModule } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import {
  DiscoveryService,
  type WellKnownDoc,
} from '../src/federation/discovery.service.js';

describe('concurrent federation key-cache replacement', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  let discovery: DiscoveryService;
  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
    discovery = new DiscoveryService(
      database,
      {} as never,
      {} as never,
      {} as never,
    );
    // Pause inserts after DELETE to expose overlapping replacement transactions.
    // This gate does not prescribe how production serializes the replacements.
    await database.pool.query(`
      CREATE FUNCTION pause_key_cache_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        PERFORM pg_advisory_xact_lock(918273645);
        RETURN NEW;
      END $$;
      CREATE TRIGGER pause_key_cache_insert BEFORE INSERT ON "S2SKeyCache"
      FOR EACH ROW EXECUTE FUNCTION pause_key_cache_insert();
    `);
  });
  afterAll(async () => {
    try {
      await database?.pool.query(`
        DROP TRIGGER IF EXISTS pause_key_cache_insert ON "S2SKeyCache";
        DROP FUNCTION IF EXISTS pause_key_cache_insert();
      `);
    } finally {
      await mod?.close();
    }
  });

  it.each([false, true])(
    'completes overlapping refreshes with existing cache=%s',
    async (populated) => {
      const domain = populated ? 'cached.test' : 'empty.test';
      const root = Buffer.alloc(32, 1).toString('base64');
      const [namespace] = await database.db
        .insert(tables.identityNamespace)
        .values({
          domain,
          rootPublicKey: root,
          rootKeyFingerprint: `sha256:${createHash('sha256').update(Buffer.from(root, 'base64')).digest('base64url')}`,
          identityPinnedAt: new Date(),
          active: true,
          trustLevel: 'available',
          recognizesPeer: true,
          localServiceAvailable: true,
          peerAcceptanceConfirmed: true,
          remoteServiceReachable: true,
        })
        .returning();
      const document = (ids: string[]): WellKnownDoc => ({
        protocolVersions: [1],
        rootKey: { ed25519: root },
        keys: ids.map((id) => ({
          keyId: `${domain}/${id}`,
          ed25519: root,
          notBefore: 1700000000000,
          notAfter: 253402300799999,
          authorizationSignature: Buffer.alloc(64).toString('base64'),
        })),
      });
      if (populated)
        await discovery.cacheDocument(
          domain,
          namespace.id,
          document(['old', 'current']),
        );
      const blocker = await database.pool.connect();
      let refreshes: Promise<PromiseSettledResult<void>[]> | undefined;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(918273645)');
        refreshes = Promise.allSettled(
          Array.from({ length: 2 }, () =>
            discovery.cacheDocument(
              domain,
              namespace.id,
              document(['current', 'next']),
            ),
          ),
        );
        const deadline = Date.now() + 5000;
        for (;;) {
          const { rows } = await database.pool.query(`
          SELECT pid FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query LIKE '%S2SKeyCache%'
        `);
          if (rows.length >= 2) break;
          if (Date.now() > deadline)
            throw new Error('refreshes did not overlap');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        await blocker.query('COMMIT');
        const results = await refreshes;
        // Include the underlying PostgreSQL code/constraint in regression failures.
        const failures = results.flatMap((result) =>
          result.status === 'rejected'
            ? [
                {
                  code: result.reason.cause?.code,
                  constraint: result.reason.cause?.constraint,
                  message:
                    result.reason.cause?.message ?? result.reason.message,
                },
              ]
            : [],
        );
        expect(failures).toEqual([]);
        const keys = await database.db
          .select()
          .from(tables.s2SKeyCache)
          .where(eq(tables.s2SKeyCache.namespaceId, namespace.id));
        expect(keys.map(({ keyId }) => keyId).sort()).toEqual([
          `${domain}/current`,
          `${domain}/next`,
        ]);
      } finally {
        await blocker.query('ROLLBACK');
        blocker.release();
        await refreshes;
      }
    },
  );
});
