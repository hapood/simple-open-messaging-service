import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  federatedPeerEvent,
  federationPullCursor,
  federationServeCursor,
  peerStateFeedPullCursor,
  peerStateFeedTarget,
} from '../src/database/schema.js';
import type { WellKnownDoc } from '../src/federation/discovery.service.js';
import { FederationCursorService } from '../src/federation/federation-cursor.service.js';
import { FederationRecognitionService } from '../src/federation/federation-recognition.service.js';
import { PeerStateFeedService } from '../src/federation/peer-state-feed.service.js';

describe('FederationRecognitionService atomic commit', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  const domain = 'atomic-recognition.test';
  const rootPublicKey = Buffer.alloc(32, 7).toString('base64');
  const document: WellKnownDoc = {
    protocolVersions: [1],
    rootKey: { ed25519: rootPublicKey },
    keys: [],
  };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  beforeEach(async () => {
    await database.pool.query(
      'DELETE FROM "FederatedPeerEvent" WHERE domain = $1',
      [domain],
    );
    await database.pool.query('DELETE FROM "FederatedPeer" WHERE domain = $1', [
      domain,
    ]);
  });

  afterAll(async () => {
    await database.pool.query(
      'DELETE FROM "FederatedPeerEvent" WHERE domain = $1',
      [domain],
    );
    await database.pool.query('DELETE FROM "FederatedPeer" WHERE domain = $1', [
      domain,
    ]);
    await mod.close();
  });

  function service(
    stateFeed: PeerStateFeedService,
  ): FederationRecognitionService {
    return new FederationRecognitionService(
      database,
      {} as never,
      {} as never,
      new FederationCursorService(database),
      stateFeed,
    );
  }

  it('commits the inbound recognition fact and every peer cursor together', async () => {
    await service(new PeerStateFeedService(database)).acceptInbound(
      domain,
      document,
    );

    expect(
      await database.db.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, domain),
      }),
    ).toMatchObject({
      trustLevel: 'establishing',
      rootPublicKey,
      inboundRecognitionConfirmed: true,
      lightweightInboundReady: true,
      reverseRecognitionPending: true,
    });
    expect(
      await database.db
        .select()
        .from(federationServeCursor)
        .where(eq(federationServeCursor.peerDomain, domain)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(federationPullCursor)
        .where(eq(federationPullCursor.peerDomain, domain)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(peerStateFeedTarget)
        .where(eq(peerStateFeedTarget.peerDomain, domain)),
    ).toHaveLength(1);
    expect(
      await database.db
        .select()
        .from(peerStateFeedPullCursor)
        .where(eq(peerStateFeedPullCursor.peerDomain, domain)),
    ).toHaveLength(1);
  });

  it('rolls back the recognition fact and cursors when initialization fails', async () => {
    const failingStateFeed = {
      initializePeerInTx: async () => {
        throw new Error('state-feed initialization failed');
      },
    } as unknown as PeerStateFeedService;

    await expect(
      service(failingStateFeed).acceptInbound(domain, document),
    ).rejects.toThrow('state-feed initialization failed');

    expect(
      await database.db
        .select()
        .from(federatedPeer)
        .where(eq(federatedPeer.domain, domain)),
    ).toEqual([]);
    expect(
      await database.db
        .select()
        .from(peerStateFeedPullCursor)
        .where(eq(peerStateFeedPullCursor.peerDomain, domain)),
    ).toEqual([]);
    expect(
      await database.db
        .select()
        .from(federationServeCursor)
        .where(eq(federationServeCursor.peerDomain, domain)),
    ).toEqual([]);
    expect(
      await database.db
        .select()
        .from(federationPullCursor)
        .where(eq(federationPullCursor.peerDomain, domain)),
    ).toEqual([]);
    expect(
      await database.db
        .select()
        .from(peerStateFeedTarget)
        .where(eq(peerStateFeedTarget.peerDomain, domain)),
    ).toEqual([]);
  });

  it('counts and logs only the available to degraded transition', async () => {
    await database.db.insert(federatedPeer).values({
      domain,
      trustLevel: 'available',
      rootPublicKey,
      identityPinnedAt: new Date(),
      recognizesPeer: true,
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: true,
      localServiceAvailable: true,
      remoteServiceReachable: true,
    });
    const recognition = service(new PeerStateFeedService(database));

    await recognition.markTransportDegraded(domain, 'first failure');
    await recognition.markTransportDegraded(domain, 'retry failure');

    expect(
      await database.db.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, domain),
      }),
    ).toMatchObject({
      trustLevel: 'degraded',
      remoteServiceReachable: false,
      degradationCount: 1,
      degradationReason: 'retry failure',
    });
    expect(
      await database.db
        .select()
        .from(federatedPeerEvent)
        .where(eq(federatedPeerEvent.domain, domain)),
    ).toMatchObject([{ type: 'degraded', reason: 'first failure' }]);
  });
});
