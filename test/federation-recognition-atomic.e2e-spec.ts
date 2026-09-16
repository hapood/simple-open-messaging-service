import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { eq } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federatedPeer,
  federatedPeerEvent,
  identityNamespace,
  peerStateFeedPullCursor,
} from '../src/database/schema.js';
import type { WellKnownDoc } from '../src/federation/discovery.service.js';
import { FederationNamespaceService } from '../src/federation/federation-namespace.service.js';
import { FederationRecognitionService } from '../src/federation/federation-recognition.service.js';

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

  async function cleanDomain() {
    await database.pool.query(
      'DELETE FROM "PeerStateFeedPullCursor" WHERE "peerDomain" = $1',
      [domain],
    );
    await database.pool.query(
      'DELETE FROM "FederatedPeerEvent" WHERE domain = $1',
      [domain],
    );
    await database.pool.query('DELETE FROM "FederatedPeer" WHERE domain = $1', [
      domain,
    ]);
    await database.pool.query(
      'DELETE FROM "IdentityNamespace" WHERE domain = $1',
      [domain],
    );
  }

  beforeEach(async () => {
    await cleanDomain();
  });

  afterAll(async () => {
    await cleanDomain();
    await mod.close();
  });

  function service(
    namespaces: FederationNamespaceService = new FederationNamespaceService(
      database,
    ),
  ): FederationRecognitionService {
    return new FederationRecognitionService(
      database,
      {} as never,
      {} as never,
      { get: () => ({ callTimeoutSec: 12 }) } as never,
      namespaces,
      { emit: () => undefined } as never,
    );
  }

  it('commits inbound recognition, namespace, and State Feed cursors together', async () => {
    await service().acceptInbound(domain, document);

    expect(
      await database.db.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, domain),
      }),
    ).toMatchObject({
      trustLevel: 'available',
      peerAcceptanceConfirmed: true,
      remoteServiceReachable: true,
    });
    expect(
      await database.db
        .select()
        .from(identityNamespace)
        .where(eq(identityNamespace.domain, domain)),
    ).toEqual([expect.objectContaining({ stateFeedEndId: 0n })]);
    expect(
      await database.db
        .select()
        .from(peerStateFeedPullCursor)
        .where(eq(peerStateFeedPullCursor.peerDomain, domain)),
    ).toHaveLength(1);
  });

  it('rolls back the recognition fact and cursors when namespace initialization fails', async () => {
    const failingNamespaces = new FederationNamespaceService(database);
    const activateVerifiedInTx =
      failingNamespaces.activateVerifiedInTx.bind(failingNamespaces);
    vi.spyOn(failingNamespaces, 'activateVerifiedInTx').mockImplementation(
      async (...args) => {
        await activateVerifiedInTx(...args);
        throw new Error('namespace initialization failed');
      },
    );

    await expect(
      service(failingNamespaces).acceptInbound(domain, document),
    ).rejects.toThrow('namespace initialization failed');

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
        .from(identityNamespace)
        .where(eq(identityNamespace.domain, domain)),
    ).toEqual([]);
  });

  it('keeps outbound recognition establishing until a retry receives OK', async () => {
    const request = vi.fn();
    const discovery = {
      resolveBase: vi.fn().mockResolvedValue('https://atomic-recognition.test'),
      fetchWellKnown: vi.fn().mockResolvedValue(document),
      cacheDocument: vi.fn().mockResolvedValue(undefined),
      acquireRequestSlot: vi.fn().mockResolvedValue(() => undefined),
      request,
    };
    const recognition = new FederationRecognitionService(
      database,
      discovery as never,
      { signOutbound: vi.fn().mockResolvedValue({}) } as never,
      { get: () => ({ callTimeoutSec: 12 }) } as never,
      new FederationNamespaceService(database),
      { emit: () => undefined } as never,
    );
    request.mockImplementationOnce(async () => {
      expect(
        await database.db.query.federatedPeer.findFirst({
          where: eq(federatedPeer.domain, domain),
        }),
      ).toMatchObject({
        trustLevel: 'establishing',
        recognizesPeer: true,
        peerAcceptanceConfirmed: false,
      });
      throw new Error('temporary connection failure');
    });

    await expect(recognition.recognize(domain)).rejects.toThrow(
      'temporary connection failure',
    );
    expect(
      await database.db.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, domain),
      }),
    ).toMatchObject({
      trustLevel: 'establishing',
      peerAcceptanceConfirmed: false,
      remoteServiceReachable: false,
    });

    request.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    await recognition.recognize(domain);
    expect(
      await database.db.query.federatedPeer.findFirst({
        where: eq(federatedPeer.domain, domain),
      }),
    ).toMatchObject({
      trustLevel: 'available',
      peerAcceptanceConfirmed: true,
      remoteServiceReachable: true,
    });
  });

  it.each(['available', 'degraded'] as const)(
    'accepts positive Health %s instead of a lost Recognize OK',
    async (status) => {
      const [namespace] = await database.db
        .insert(identityNamespace)
        .values({
          domain,
          rootPublicKey,
          rootKeyFingerprint: 'test-fingerprint',
          identityPinnedAt: new Date(),
        })
        .returning({ id: identityNamespace.id });
      await database.db.insert(federatedPeer).values({
        domain,
        activeNamespaceId: namespace!.id,
        trustLevel: 'establishing',
        recognizesPeer: true,
        peerAcceptanceConfirmed: false,
        localServiceAvailable: true,
        remoteServiceReachable: false,
      });
      const discovery = {
        resolveBase: vi
          .fn()
          .mockResolvedValue('https://atomic-recognition.test'),
        acquireRequestSlot: vi.fn().mockResolvedValue(() => undefined),
        request: vi
          .fn()
          .mockResolvedValue(
            new Response(JSON.stringify({ status }), { status: 200 }),
          ),
      };
      const recognition = new FederationRecognitionService(
        database,
        discovery as never,
        { signOutbound: vi.fn().mockResolvedValue({}) } as never,
        { get: () => ({ callTimeoutSec: 12 }) } as never,
        new FederationNamespaceService(database),
        { emit: () => undefined } as never,
      );

      await expect(recognition.checkHealth(domain)).resolves.toBe(status);
      expect(
        await database.db.query.federatedPeer.findFirst({
          where: eq(federatedPeer.domain, domain),
        }),
      ).toMatchObject({
        trustLevel: 'available',
        peerAcceptanceConfirmed: true,
        remoteServiceReachable: true,
      });
    },
  );

  it('counts and logs only the available to degraded transition', async () => {
    const [namespace] = await database.db
      .insert(identityNamespace)
      .values({
        domain,
        rootPublicKey,
        rootKeyFingerprint: 'test-fingerprint',
        identityPinnedAt: new Date(),
      })
      .returning({ id: identityNamespace.id });
    await database.db.insert(federatedPeer).values({
      domain,
      activeNamespaceId: namespace!.id,
      trustLevel: 'available',
      recognizesPeer: true,
      peerAcceptanceConfirmed: true,
      localServiceAvailable: true,
      remoteServiceReachable: true,
    });
    const recognition = service();

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
