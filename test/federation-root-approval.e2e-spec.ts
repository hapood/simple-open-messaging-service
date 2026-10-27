import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { ed25519 } from '@noble/curves/ed25519.js';
import { eq, sql } from 'drizzle-orm';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federationIdentityReview,
  identityNamespace,
} from '../src/database/schema.js';
import { FederationNamespaceAdminService } from '../src/admin/federation-namespace-admin.service.js';
import { BusinessCode } from '../src/common/business-code.js';
import { openSealedBox } from '../src/federation/sealed-box.js';
import { ProfileNamespaceFeedService } from '../src/federation/profile-namespace-feed.service.js';
import { ProfileNamespaceChangeStore } from '../src/federation/profile-namespace-change-store.service.js';

describe('database-backed root approval proof binding', () => {
  const domain = 'root-approval-proof.test';
  const secret = Buffer.alloc(32, 81);
  const predecessor = Buffer.from(ed25519.getPublicKey(secret)).toString(
    'base64',
  );
  const successor = Buffer.from(
    ed25519.getPublicKey(Buffer.alloc(32, 82)),
  ).toString('base64');
  let mod: TestingModule;
  let database: DatabaseService;
  let namespaceId: number;
  let reviewId: number;

  async function cleanup() {
    for (const table of [
      'S2SKeyCache',
      'FederationFeedHeadReceipt',
      'FederationFeedState',
      'ProfileNamespaceFeed',
      'ProfileNamespaceChangeFeed',
    ]) {
      const column =
        table === 'ProfileNamespaceChangeFeed'
          ? 'publisherNamespaceId'
          : 'namespaceId';
      await database.pool.query(
        `DELETE FROM "${table}" WHERE "${column}" IN (SELECT id FROM "IdentityNamespace" WHERE domain = $1)`,
        [domain],
      );
    }
    await database.db
      .delete(identityNamespace)
      .where(eq(identityNamespace.domain, domain));
  }

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  beforeEach(async () => {
    await cleanup();
    const [namespace] = await database.db
      .insert(identityNamespace)
      .values({
        domain,
        rootPublicKey: predecessor,
        signingKeyCreatedAt: 1700000000000,
        identityPinnedAt: new Date(),
        active: true,
        trustLevel: 'available',
        peerAcceptanceConfirmed: true,
        localServiceAvailable: true,
        remoteServiceReachable: true,
      })
      .returning({ id: identityNamespace.id });
    namespaceId = namespace!.id;
    const [review] = await database.db
      .insert(federationIdentityReview)
      .values({
        kind: 'root-rotation',
        matchedNamespaceId: namespaceId,
        nextDomain: domain,
        claimedRoot: successor,
        claim: { previousRoot: predecessor, claimedRoot: successor },
      })
      .returning({ id: federationIdentityReview.id });
    reviewId = review!.id;
  });

  afterAll(async () => {
    await cleanup();
    await mod.close();
  });

  function approvalSubject() {
    const feed = new ProfileNamespaceFeedService(
      database,
      new ProfileNamespaceChangeStore(database),
    );
    const notify = vi.fn();
    const refresh = vi.fn();
    const service = new FederationNamespaceAdminService(
      database,
      feed,
      { scheduleRefresh: refresh } as never,
      { notifyProfileNamespaceChange: notify } as never,
      {
        fetchWellKnown: async () => ({
          protocolVersions: [1],
          signingKeyCreatedAt: 1700000000000,
          roots: [
            { ed25519: successor, notBefore: 0, notAfter: 253402300799999 },
          ],
          keys: [
            {
              keyId: `${domain}/successor`,
              ed25519: successor,
              root: successor,
              notBefore: 0,
              notAfter: 253402300799999,
              authorizationSignature: Buffer.alloc(64).toString('base64'),
            },
          ],
        }),
        resolveBase: async () => `https://${domain}`,
        acquireRequestSlot: async () => () => undefined,
        request: async (_url: URL, init: RequestInit) => {
          const body = JSON.parse(init.body as string) as {
            encryptedValue: string;
          };
          const opened = openSealedBox(
            Buffer.from(body.encryptedValue, 'base64'),
            secret,
          );
          return new Response(
            JSON.stringify({
              code: 0,
              data: { value: Buffer.from(opened!).toString('base64') },
            }),
            { status: 200 },
          );
        },
      } as never,
      { signOutbound: async () => ({}) } as never,
      { get: () => ({ callTimeoutSec: 12 }) } as never,
    );
    return { service, notify, refresh };
  }

  it.each(['new-peer', 'replace-identity'] as const)(
    'commits identity discontinuity decision %s against the live namespace',
    async (resolution) => {
      await database.db
        .update(identityNamespace)
        .set({
          trustLevel: 'halted',
          haltedAt: new Date(),
          haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
          haltReason: 'pinned predecessor is no longer published',
        })
        .where(eq(identityNamespace.id, namespaceId));
      await database.db
        .update(federationIdentityReview)
        .set({ kind: 'identity-reset' })
        .where(eq(federationIdentityReview.id, reviewId));
      const { service } = approvalSubject();
      expect(
        (await service.pendingReviews()).find((r) => r.id === reviewId)
          ?.epochMatched,
      ).toBe(true);
      await expect(
        service.approve(reviewId, resolution),
      ).resolves.toMatchObject({
        status: 'approved',
        activeNamespaceId: resolution === 'new-peer' ? null : namespaceId,
      });
      const ns = await database.db.query.identityNamespace.findFirst({
        where: eq(identityNamespace.id, namespaceId),
      });
      if (resolution === 'new-peer') {
        expect(ns).toMatchObject({ active: false, rootPublicKey: predecessor });
        expect(ns?.retiredAt).toBeInstanceOf(Date);
      } else {
        expect(ns).toMatchObject({
          active: true,
          rootPublicKey: successor,
          trustLevel: 'available',
          haltCode: null,
        });
        expect(ns?.retiredAt).toBeNull();
      }
    },
  );

  it('rejects discontinuity without changing the halted namespace', async () => {
    await database.db
      .update(identityNamespace)
      .set({
        trustLevel: 'halted',
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      })
      .where(eq(identityNamespace.id, namespaceId));
    await database.db
      .update(federationIdentityReview)
      .set({ kind: 'identity-reset' })
      .where(eq(federationIdentityReview.id, reviewId));
    await approvalSubject().service.reject(reviewId);
    expect(
      await database.db.query.identityNamespace.findFirst({
        where: eq(identityNamespace.id, namespaceId),
      }),
    ).toMatchObject({
      rootPublicKey: predecessor,
      trustLevel: 'halted',
      active: true,
    });
  });

  it('computes list matching from the live pin and retirement, not halt policy', async () => {
    const { service } = approvalSubject();
    const matches = async () =>
      (await service.pendingReviews()).find((r) => r.id === reviewId)
        ?.epochMatched;
    expect(await matches()).toBe(true);
    await database.db
      .update(identityNamespace)
      .set({
        trustLevel: 'halted',
        haltCode: BusinessCode.FEDERATION_PEER_BLOCKED,
      })
      .where(eq(identityNamespace.id, namespaceId));
    expect(await matches()).toBe(true);
    await database.db
      .update(identityNamespace)
      .set({ rootPublicKey: successor })
      .where(eq(identityNamespace.id, namespaceId));
    expect(await matches()).toBe(false);
    await database.db
      .update(identityNamespace)
      .set({
        rootPublicKey: predecessor,
        active: false,
        retiredAt: new Date(),
      })
      .where(eq(identityNamespace.id, namespaceId));
    expect(await matches()).toBe(false);
  });

  async function snapshot() {
    const result: Record<string, unknown> = {};
    for (const table of [
      'IdentityNamespace',
      'S2SKeyCache',
      'FederationIdentityReview',
      'ProfileNamespaceFeed',
      'ProfileNamespaceChangeFeed',
      'ProfileNamespaceChangeFeedHead',
    ]) {
      result[table] = (
        await database.pool.query(
          `SELECT jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text) AS rows FROM "${table}" t`,
        )
      ).rows[0].rows;
    }
    return result;
  }

  it.each(['S2SKeyCache', 'FederationIdentityReview'] as const)(
    'rolls back the entire approval when writing %s fails',
    async (table) => {
      await database.pool.query(
        `
        INSERT INTO "S2SKeyCache"
          (domain, "namespaceId", "keyId", "publicKey", root, "notBefore", "notAfter", "authorizationSignature")
        VALUES ($1, $2, $3, $4, $4, now() - interval '1 day', now() + interval '1 day', $5)
      `,
        [
          domain,
          namespaceId,
          `${domain}/old`,
          predecessor,
          Buffer.alloc(64).toString('base64'),
        ],
      );
      const before = await snapshot();
      const { service, notify, refresh } = approvalSubject();
      await database.pool.query(`
        CREATE FUNCTION fail_root_approval_write() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'injected approval write failure'; END $$;
        CREATE TRIGGER fail_root_approval_write BEFORE ${table === 'S2SKeyCache' ? 'INSERT' : 'UPDATE'}
        ON "${table}" FOR EACH ROW EXECUTE FUNCTION fail_root_approval_write();
      `);
      try {
        await expect(service.approve(reviewId)).rejects.toMatchObject({
          cause: { code: 'P0001', message: 'injected approval write failure' },
        });
        expect(await snapshot()).toEqual(before);
        expect(notify).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
      } finally {
        await database.pool.query(
          `DROP TRIGGER fail_root_approval_write ON "${table}"; DROP FUNCTION fail_root_approval_write();`,
        );
      }
    },
  );

  it.each([true, false])(
    'installs successor certificates without inventing acceptance (accepted: %s)',
    async (accepted) => {
      await database.db
        .update(identityNamespace)
        .set({
          trustLevel: accepted ? 'degraded' : 'establishing',
          peerAcceptanceConfirmed: accepted,
          remoteServiceReachable: false,
        })
        .where(eq(identityNamespace.id, namespaceId));
      await approvalSubject().service.approve(reviewId);
      const namespace = await database.db.query.identityNamespace.findFirst({
        where: eq(identityNamespace.id, namespaceId),
      });
      expect(namespace).toMatchObject({
        rootPublicKey: successor,
        peerAcceptanceConfirmed: accepted,
        remoteServiceReachable: true,
        trustLevel: accepted ? 'available' : 'establishing',
      });
      const keys = await database.pool.query(
        'SELECT root FROM "S2SKeyCache" WHERE "namespaceId" = $1',
        [namespaceId],
      );
      expect(keys.rows).toEqual([{ root: successor }]);
    },
  );

  it.each(['domain', 'successor', 'predecessor', 'rejection', 'pin'] as const)(
    'rejects approval when %s changes during a successful challenge',
    async (change) => {
      let concurrentWriteCommitted = false;
      const recordNamespaceChangeInTx = vi.fn();
      const service = new FederationNamespaceAdminService(
        database,
        { recordNamespaceChangeInTx } as never,
        {} as never,
        {} as never,
        {
          fetchWellKnown: async () => ({
            protocolVersions: [1],
            signingKeyCreatedAt: 1700000000000,
            roots: [
              { ed25519: successor, notBefore: 0, notAfter: 253402300799999 },
            ],
            keys: [
              {
                keyId: `${domain}/successor`,
                ed25519: successor,
                root: successor,
                notBefore: 0,
                notAfter: 253402300799999,
                authorizationSignature: Buffer.alloc(64).toString('base64'),
              },
            ],
          }),
          resolveBase: async () => `https://${domain}`,
          acquireRequestSlot: async () => () => undefined,
          request: async (_url: URL, init: RequestInit) => {
            // This transaction uses another pooled connection. It must acquire
            // both rows while approval is waiting for its remote proof.
            await database.db.transaction(async (tx) => {
              await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
              await tx.execute(sql`
                SELECT id FROM "FederationIdentityReview"
                WHERE id = ${reviewId} FOR NO KEY UPDATE
              `);
              await tx.execute(sql`
                SELECT id FROM "IdentityNamespace"
                WHERE id = ${namespaceId} FOR NO KEY UPDATE
              `);
              if (change === 'pin') {
                await tx
                  .update(identityNamespace)
                  .set({ rootPublicKey: successor })
                  .where(eq(identityNamespace.id, namespaceId));
              } else {
                await tx
                  .update(federationIdentityReview)
                  .set(
                    change === 'domain'
                      ? { nextDomain: 'other-root-approval.test' }
                      : change === 'successor'
                        ? { claimedRoot: predecessor }
                        : change === 'predecessor'
                          ? {
                              claim: {
                                previousRoot: successor,
                                claimedRoot: successor,
                              },
                            }
                          : { status: 'rejected', reviewedAt: new Date() },
                  )
                  .where(eq(federationIdentityReview.id, reviewId));
              }
            });
            concurrentWriteCommitted = true;
            const body = JSON.parse(init.body as string) as {
              publicKey: string;
              encryptedValue: string;
            };
            expect(body.publicKey).toBe(predecessor);
            const opened = openSealedBox(
              Buffer.from(body.encryptedValue, 'base64'),
              secret,
            );
            expect(opened).not.toBeNull();
            return new Response(
              JSON.stringify({
                code: 0,
                data: { value: Buffer.from(opened!).toString('base64') },
              }),
              { status: 200 },
            );
          },
        } as never,
        { signOutbound: async () => ({}) } as never,
        { get: () => ({ callTimeoutSec: 12 }) } as never,
      );
      await expect(service.approve(reviewId)).rejects.toMatchObject({
        bizCode:
          change === 'pin'
            ? BusinessCode.FEDERATION_PEER_IDENTITY_LOST
            : BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
      });
      expect(concurrentWriteCommitted).toBe(true);
      expect(recordNamespaceChangeInTx).not.toHaveBeenCalled();
      const review = await database.db.query.federationIdentityReview.findFirst(
        {
          where: eq(federationIdentityReview.id, reviewId),
        },
      );
      expect(review!.status).toBe(
        change === 'rejection' ? 'rejected' : 'pending',
      );
      const namespace = await database.db.query.identityNamespace.findFirst({
        where: eq(identityNamespace.id, namespaceId),
      });
      expect(namespace).toMatchObject({
        rootPublicKey: change === 'pin' ? successor : predecessor,
        trustLevel: 'available',
        retiredAt: null,
      });
    },
  );
});
