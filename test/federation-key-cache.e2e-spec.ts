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

  it('persists discovery metadata atomically and never accepts it from a mismatched identity', async () => {
    const domain = 'metadata.test';
    const root = createHash('sha256').update(domain).digest('base64');
    const [namespace] = await database.db
      .insert(tables.identityNamespace)
      .values({
        domain,
        rootPublicKey: root,
        signingKeyCreatedAt: 1700000000000,
        identityPinnedAt: new Date(),
        active: true,
      })
      .returning();
    expect(namespace.signingKeyCreatedAt).toBe(1700000000000);
    const document: WellKnownDoc = {
      protocolVersions: [1],
      signingKeyCreatedAt: 1700000000123,
      roots: [{ ed25519: root, notBefore: 0, notAfter: 253402300799999 }],
      keys: [
        {
          keyId: `${domain}/current`,
          ed25519: root,
          root,
          notBefore: 1700000000000,
          notAfter: 253402300799999,
          authorizationSignature: Buffer.alloc(64).toString('base64'),
        },
      ],
    };
    const read = () =>
      database.db.query.identityNamespace.findFirst({
        where: eq(tables.identityNamespace.id, namespace.id),
      });
    await discovery.cacheDocument(domain, namespace.id, document);
    expect((await read())!.signingKeyCreatedAt).toBe(1700000000123);
    // Refreshes replace rather than maximize the timestamp: clock corrections
    // and a different active key can produce an earlier creation time.
    await discovery.cacheDocument(domain, namespace.id, {
      ...document,
      signingKeyCreatedAt: 1000,
    });
    expect((await read())!.signingKeyCreatedAt).toBe(1000);
    // A failed cache insertion must also roll back the metadata replacement.
    await expect(
      discovery.cacheDocument(domain, namespace.id, {
        ...document,
        keys: [document.keys[0], document.keys[0]],
      }),
    ).rejects.toThrow();
    expect((await read())!.signingKeyCreatedAt).toBe(1000);
    await expect(
      discovery.cacheDocument(domain, namespace.id, {
        ...document,
        roots: [],
      }),
    ).rejects.toThrow();
    expect((await read())!.signingKeyCreatedAt).toBe(1000);
    const { signingKeyCreatedAt: _createdAt, ...missingTime } = document;
    await expect(
      discovery.cacheDocument(
        domain,
        namespace.id,
        missingTime as WellKnownDoc,
      ),
    ).rejects.toThrow();
    expect((await read())!.signingKeyCreatedAt).toBe(1000);
    for (const signingKeyCreatedAt of [
      0,
      -1,
      Number.MAX_SAFE_INTEGER + 1,
      null,
    ]) {
      await expect(
        database.db
          .update(tables.identityNamespace)
          .set({
            signingKeyCreatedAt: signingKeyCreatedAt as number,
          })
          .where(eq(tables.identityNamespace.id, namespace.id)),
      ).rejects.toThrow();
    }
  });

  it.each([false, true])(
    'completes overlapping refreshes with existing cache=%s',
    async (populated) => {
      const domain = populated ? 'cached.test' : 'empty.test';
      const root = createHash('sha256')
        .update(`key-cache-root:${domain}`)
        .digest('base64');
      const [namespace] = await database.db
        .insert(tables.identityNamespace)
        .values({
          domain,
          rootPublicKey: root,
          signingKeyCreatedAt: 1700000000000,
          identityPinnedAt: new Date(),
          active: true,
          trustLevel: 'available',
          localServiceAvailable: true,
          peerAcceptanceConfirmed: true,
          remoteServiceReachable: true,
        })
        .returning();
      const document = (ids: string[]): WellKnownDoc => ({
        protocolVersions: [1],
        signingKeyCreatedAt: ids.includes('next')
          ? 1700000000123
          : 1600000000123,
        roots: [
          {
            ed25519: root,
            notBefore: 0,
            notAfter: 253402300799999,
          },
        ],
        keys: ids.map((id) => ({
          keyId: `${domain}/${id}`,
          ed25519: root,
          root,
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
        expect(
          (await database.db.query.identityNamespace.findFirst({
            where: eq(tables.identityNamespace.id, namespace.id),
          }))!.signingKeyCreatedAt,
        ).toBe(1700000000123);
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
