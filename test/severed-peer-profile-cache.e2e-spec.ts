import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { DatabaseService } from '../src/database/database.service.js';
import * as tables from '../src/database/schema.js';
import { BusinessCode } from '../src/common/business-code.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { ProfileResolutionCoordinatorService } from '../src/profile-resolution/profile-resolution-coordinator.service.js';
import { ProfileResolutionController } from '../src/profile-resolution/profile-resolution.controller.js';
import type { ProfileDemand } from '../shared/profile-demand.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('cold-session profile lookup after friendship revocation', () => {
  let database: DatabaseService;
  let profiles: FederationProfileService;
  let viewerId: number;
  let foreignNamespace: number;
  const viewer = 'cache-revoked-viewer';
  const peer = 'cache-revoked-peer';
  const demand: ProfileDemand = {
    publisherNamespaceId: 0,
    lookup: 'ACCOUNT_PROFILE',
    target: { profileNamespaceId: 0, account: peer, rev: 1 },
  };
  const sse = { onProfileAvailable: vi.fn(), onProfileUnavailable: vi.fn() };
  const request = () =>
    ({ user: { userId: viewerId, sessionId: 123 } }) as FastifyRequest;
  const controller = () =>
    new ProfileResolutionController(
      new ProfileResolutionCoordinatorService(database, profiles, sse as never),
    );

  beforeAll(async () => {
    database = new DatabaseService();
    profiles = new FederationProfileService(
      database,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    vi.spyOn(profiles, 'fetchExactAccountProfile').mockRejectedValue(
      new Error('unexpected federation fetch'),
    );
    vi.spyOn(profiles, 'fetchExactGroupMemberProfile').mockRejectedValue(
      new Error('unexpected federation fetch'),
    );
    foreignNamespace = await seedFederatedPeerNamespace(
      database.db,
      'revoked-cache-peer.test',
    );
    const [account] = await database.db
      .insert(tables.account)
      .values({ account: viewer, defaultProfileRev: 1 })
      .returning();
    viewerId = account.id;
    await database.db
      .insert(tables.account)
      .values({ account: peer, defaultProfileRev: 2 });
    await database.db.insert(tables.profileTable).values([
      {
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        account: peer,
        profileRev: 1,
        generatedAt: 1_700_000_000_000,
        displayName: 'Retained Peer',
        bio: 'Historical snapshot',
      },
      {
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        account: peer,
        profileRev: 2,
        generatedAt: 1_700_000_000_000,
        displayName: 'Current Peer',
      },
      {
        publisherNamespaceId: foreignNamespace,
        profileNamespaceId: 77,
        account: peer,
        profileRev: 1,
        generatedAt: 1_700_000_000_000,
        displayName: 'Foreign Retained Peer',
      },
    ]);
    const [thread] = await database.db
      .insert(tables.messageThread)
      .values({ type: 'P2P', updatedAt: new Date() })
      .returning();
    await database.db.insert(tables.relationshipPair).values({
      kind: 'P2P',
      threadId: thread.id,
      established: true,
      active: false,
      endpointAType: 'USER',
      endpointAAccount: viewer,
      endpointANamespaceId: 0,
      endpointBType: 'USER',
      endpointBAccount: peer,
      endpointBNamespaceId: 0,
    });
    await database.db.insert(tables.accountThreadState).values({
      accountId: viewerId,
      threadId: thread.id,
      threadProfileRev: 1,
    });
    await database.db.insert(tables.relationshipIntent).values([
      {
        authorAccount: viewer,
        authorNamespaceId: 0,
        receiverAccount: peer,
        receiverNamespaceId: 0,
        statusChangedAt: new Date(),
        status: 'REVOKED',
        profileNamespaceId: 0,
        profileRev: 1,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
      },
      {
        authorAccount: peer,
        authorNamespaceId: 0,
        receiverAccount: viewer,
        receiverNamespaceId: 0,
        statusChangedAt: new Date(),
        status: 'REVOKED',
        profileNamespaceId: 0,
        profileRev: 1,
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
      },
    ]);
  });
  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  it('short-circuits ordinary resolution on an existing snapshot despite revoked authorization', async () => {
    await expect(controller().start(request(), demand)).resolves.toMatchObject({
      status: 'READY',
      profile: { account: peer, rev: 1, name: 'Retained Peer' },
    });
  });

  it('still rejects ordinary resolution on a cache miss without authorization', async () => {
    await expect(
      controller().start(request(), {
        ...demand,
        target: { ...demand.target, rev: 3 },
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
  });

  it('recovers the retained exact snapshot without a relationship grant or an in-memory cache', async () => {
    await expect(
      controller().start(request(), { demand, evidence: null }),
    ).resolves.toMatchObject({
      status: 'READY',
      profile: {
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        account: peer,
        rev: 1,
        name: 'Retained Peer',
        bio: 'Historical snapshot',
      },
    });
  });

  it.each([false, true])(
    'serves a cached foreign snapshot without contacting its source (evidenced: %s)',
    async (evidenced) => {
      const foreignDemand = {
        ...demand,
        publisherNamespaceId: foreignNamespace,
        target: { ...demand.target, profileNamespaceId: 77 },
      };
      await expect(
        controller().start(
          request(),
          evidenced ? foreignDemand : { demand: foreignDemand, evidence: null },
        ),
      ).resolves.toMatchObject({
        status: 'READY',
        profile: {
          publisherNamespaceId: foreignNamespace,
          profileNamespaceId: 77,
          rev: 1,
          name: 'Foreign Retained Peer',
        },
      });
    },
  );

  it.each(['revision', 'profile namespace', 'publisher namespace'])(
    'does not substitute another snapshot on a %s cache miss',
    async (coordinate) => {
      const missing = { ...demand, target: { ...demand.target } };
      if (coordinate === 'revision') missing.target.rev = 3;
      if (coordinate === 'profile namespace')
        missing.target.profileNamespaceId = 77;
      if (coordinate === 'publisher namespace')
        missing.publisherNamespaceId = foreignNamespace;
      await expect(
        controller().start(request(), { demand: missing, evidence: null }),
      ).rejects.toMatchObject({ bizCode: BusinessCode.NOT_FOUND });
    },
  );

  it('does not enqueue federation work or emit profile callbacks for cache lookups', () => {
    expect(profiles.fetchExactAccountProfile).not.toHaveBeenCalled();
    expect(profiles.fetchExactGroupMemberProfile).not.toHaveBeenCalled();
    expect(sse.onProfileAvailable).not.toHaveBeenCalled();
    expect(sse.onProfileUnavailable).not.toHaveBeenCalled();
  });
});
