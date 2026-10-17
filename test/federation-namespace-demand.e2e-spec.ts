import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import { identityNamespace, profileNamespace } from '../src/database/schema.js';
import { ProfileNamespaceService } from '../src/federation/profile-namespace.service.js';
import { ProfileNamespaceRefreshService } from '../src/federation/profile-namespace-refresh.service.js';
import { ProfileNamespaceResolutionService } from '../src/federation/profile-namespace-resolution.service.js';
import { ProfileNamespaceFeedService } from '../src/federation/profile-namespace-feed.service.js';
import { ProfileNamespaceChangeStore } from '../src/federation/profile-namespace-change-store.service.js';
import { ProfileNamespaceController } from '../src/controller/profile-namespace.controller.js';
import { seedFederatedPeerNamespace, fakeRootPublicKey } from './seed.js';
import { assertFederationWireSchema } from './support/federation-wire-schema.js';

describe('client namespace demand after prefetch work is absent', () => {
  const domain = `namespace-demand-${Date.now().toString(36)}.test`;
  let database: DatabaseService;
  let controller: ProfileNamespaceController;
  let refresh: ProfileNamespaceRefreshService;
  let feed: ProfileNamespaceFeedService;
  let publisherNamespaceId: number;
  const peerGet = vi.fn();
  const notify = vi.fn();

  beforeAll(async () => {
    database = new DatabaseService();
    publisherNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      domain,
    );
    await database.db
      .update(identityNamespace)
      .set({
        profileNamespaceFeedPulledThrough: 8n,
        profileNamespaceFeedEndId: 8n,
      })
      .where(eq(identityNamespace.id, publisherNamespaceId));
    feed = new ProfileNamespaceFeedService(
      database,
      {} as never,
      new ProfileNamespaceChangeStore(database),
    );
    refresh = new ProfileNamespaceRefreshService(
      database,
      { get: peerGet } as never,
      { run: (_domain: string, work: () => unknown) => work() } as never,
      { capturePeerResponseToken: async () => ({ domain }) } as never,
      feed,
      { notifyProfileNamespaceChange: notify } as never,
    );
    const resolution = new ProfileNamespaceResolutionService(
      new ProfileNamespaceService(database, {} as never),
      refresh,
    );
    controller = new ProfileNamespaceController(resolution);
  });

  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  async function demand() {
    const pair = { publisherNamespaceId, profileNamespaceId: 0 };
    expect(await controller.resolve(pair)).toEqual({ status: 'PENDING' });
    await vi.waitFor(async () => {
      expect(await controller.resolve(pair)).toMatchObject({
        status: 'READY',
        entry: {
          ...pair,
          domain,
          rootPublicKey: fakeRootPublicKey(domain),
          expired: false,
          updateFeedId: 8,
        },
      });
    });
    expect(peerGet).not.toHaveBeenCalled();
  }

  it('fetches an existing expired binding rather than reporting its database row as READY', async () => {
    await database.db.insert(profileNamespace).values({
      publisherNamespaceId,
      profileNamespaceId: 0,
      domain,
      rootPublicKey: fakeRootPublicKey(domain),
      expired: true,
      updateFeedId: 2n,
    });
    await demand();
    expect(notify).toHaveBeenCalledOnce();
  });

  it('fetches a missing binding while retaining the tomb for feed invalidation', async () => {
    await database.db
      .delete(profileNamespace)
      .where(
        and(
          eq(profileNamespace.publisherNamespaceId, publisherNamespaceId),
          eq(profileNamespace.profileNamespaceId, 0),
        ),
      );
    await demand();
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it.each(['ACTIVE', 'ARCHIVED'] as const)(
    'refreshes real producer bindings without a wire status and retains local %s lifecycle',
    async (status) => {
      const subjectDomain = `${status.toLowerCase()}-${domain}`;
      const profileNamespaceId = await seedFederatedPeerNamespace(
        database.db,
        subjectDomain,
      );
      const pair = { publisherNamespaceId, profileNamespaceId };
      if (status === 'ARCHIVED') {
        await database.db.insert(profileNamespace).values({
          ...pair,
          domain: subjectDomain,
          rootPublicKey: fakeRootPublicKey(subjectDomain),
          expired: true,
          status,
        });
      }
      const bindings = await feed.resolveBindings(profileNamespaceId);
      assertFederationWireSchema('urn:somfp:v1:profile-namespace', bindings);
      expect(bindings).toEqual({
        domain: subjectDomain,
        rootPublicKey: fakeRootPublicKey(subjectDomain),
        profileNamespaceFeedEndId: expect.any(String),
      });
      peerGet.mockResolvedValueOnce(bindings);
      refresh.scheduleRefresh(pair, 0n);
      await vi.waitFor(async () => {
        const row = await database.db.query.profileNamespace.findFirst({
          where: and(
            eq(profileNamespace.publisherNamespaceId, publisherNamespaceId),
            eq(profileNamespace.profileNamespaceId, profileNamespaceId),
          ),
        });
        expect(row).toMatchObject({
          ...pair,
          domain: subjectDomain,
          rootPublicKey: fakeRootPublicKey(subjectDomain),
          updateFeedId: BigInt(bindings.profileNamespaceFeedEndId),
          expired: false,
          status,
        });
      });
    },
  );
});
