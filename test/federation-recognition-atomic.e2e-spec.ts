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
import { identityNamespace } from '../src/database/schema.js';
import type { WellKnownDoc } from '../src/federation/discovery.service.js';
import { FederationNamespaceService } from '../src/federation/federation-namespace.service.js';
import { ProfileNamespaceChangeStore } from '../src/federation/profile-namespace-change-store.service.js';
import { ProfileNamespaceFeedService } from '../src/federation/profile-namespace-feed.service.js';
import { ProfileNamespaceService } from '../src/federation/profile-namespace.service.js';
import { FederationRecognitionService } from '../src/federation/federation-recognition.service.js';
import { BusinessCode } from '../src/common/business-code.js';

describe('FederationRecognitionService atomic commit', () => {
  let mod: TestingModule;
  let database: DatabaseService;
  const domain = 'atomic-recognition.test';
  const rootPublicKey = Buffer.alloc(32, 7).toString('base64');
  const document: WellKnownDoc = {
    protocolVersions: [1],
    roots: [
      {
        ed25519: rootPublicKey,
        notBefore: 0,
        notAfter: 253402300799999,
      },
    ],
    keys: [
      {
        keyId: `${domain}/test-key`,
        ed25519: rootPublicKey,
        root: rootPublicKey,
        notBefore: 0,
        notAfter: 253402300799999,
        authorizationSignature: Buffer.alloc(64).toString('base64'),
      },
    ],
  };

  beforeAll(async () => {
    mod = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = mod.get(DatabaseService);
  });

  async function cleanDomain() {
    await database.pool.query(
      `WITH doomed AS (
         SELECT id FROM "IdentityNamespace" WHERE domain = $1
       )
       DELETE FROM "ProfileNamespaceFeed"
       WHERE "namespaceId" IN (SELECT id FROM doomed)`,
      [domain],
    );
    await database.pool.query(
      `WITH doomed AS (
         SELECT id FROM "IdentityNamespace" WHERE domain = $1
       )
       DELETE FROM "ProfileNamespace"
       WHERE "publisherNamespaceId" IN (SELECT id FROM doomed)
          OR "profileNamespaceId" IN (SELECT id FROM doomed)`,
      [domain],
    );
    await database.pool.query(
      'DELETE FROM "IdentityNamespace" WHERE domain = $1',
      [domain],
    );
  }

  beforeEach(async () => {
    await cleanDomain();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanDomain();
    await mod.close();
  });

  async function activeNamespace() {
    return database.db.query.identityNamespace.findFirst({
      where: eq(identityNamespace.domain, domain),
    });
  }

  async function seedActiveNamespace(
    values?: Partial<typeof identityNamespace.$inferInsert>,
  ) {
    const [namespace] = await database.db
      .insert(identityNamespace)
      .values({
        domain,
        rootPublicKey,
        identityPinnedAt: new Date(),
        active: true,
        trustLevel: 'available',
        peerAcceptanceConfirmed: true,
        localServiceAvailable: true,
        remoteServiceReachable: true,
        ...values,
      })
      .returning({ id: identityNamespace.id });
    return namespace!;
  }

  function namespaceService(): FederationNamespaceService {
    const changes = new ProfileNamespaceChangeStore(database);
    return new FederationNamespaceService(
      database,
      new ProfileNamespaceFeedService(database, {} as never, changes),
      new ProfileNamespaceService(database, {} as never),
    );
  }

  function service(
    namespaces: FederationNamespaceService = namespaceService(),
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
    await service().acceptInbound(domain, rootPublicKey);

    expect(await activeNamespace()).toMatchObject({
      trustLevel: 'available',
      peerAcceptanceConfirmed: true,
      remoteServiceReachable: true,
      stateFeedEndId: 0n,
    });
    // The drain progress lives on the epoch row itself; NULL is the
    // never-bootstrapped marker the first state-feed pull resolves.
    expect(await activeNamespace()).toMatchObject({
      stateFeedPulledThrough: null,
    });
  });

  it('returns the receiver-assigned peer id when the two namespace spaces differ', async () => {
    const otherPeer = await seedActiveNamespace({
      domain: 'atomic-recognition-other.test',
      rootPublicKey: Buffer.alloc(32, 9).toString('base64'),
    });
    try {
      const peerAssignedLocalNamespaceId = 1;
      const peer = await seedActiveNamespace({ peerAssignedLocalNamespaceId });
      expect(peer.id).not.toBe(peerAssignedLocalNamespaceId);
      expect(
        await service()['readRecognizedInbound'](domain, rootPublicKey),
      ).toEqual({
        ok: true,
        status: 'recognized',
        peerAssignedLocalNamespaceId: peer.id,
      });
      expect(await activeNamespace()).toMatchObject({
        id: peer.id,
        peerAssignedLocalNamespaceId,
      });
    } finally {
      await database.db
        .delete(identityNamespace)
        .where(eq(identityNamespace.id, otherPeer.id));
    }
  });

  it('rejects a conflicting sender-assigned local namespace on an existing recognition', async () => {
    await seedActiveNamespace({
      peerAssignedLocalNamespaceId: 900,
    });

    await expect(
      service().acceptInbound(domain, rootPublicKey, 901),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
    });
    expect(await activeNamespace()).toMatchObject({
      trustLevel: 'halted',
      haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
    });
  });

  it('adopts a first-time sender-assigned local namespace disclosure', async () => {
    await seedActiveNamespace();

    await service().acceptInbound(domain, rootPublicKey, 901);

    expect(await activeNamespace()).toMatchObject({
      trustLevel: 'available',
      peerAssignedLocalNamespaceId: 901,
    });
  });

  it('rolls back the recognition fact when namespace initialization fails', async () => {
    const failingNamespaces = namespaceService();
    const activateVerifiedInTx =
      failingNamespaces.activateVerifiedInTx.bind(failingNamespaces);
    vi.spyOn(failingNamespaces, 'activateVerifiedInTx').mockImplementation(
      async (...args) => {
        await activateVerifiedInTx(...args);
        throw new Error('namespace initialization failed');
      },
    );

    await expect(
      service(failingNamespaces).acceptInbound(domain, rootPublicKey),
    ).rejects.toThrow('namespace initialization failed');

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
      namespaceService(),
      { emit: () => undefined } as never,
    );
    request.mockImplementationOnce(async () => {
      expect(await activeNamespace()).toMatchObject({
        trustLevel: 'establishing',
        peerAcceptanceConfirmed: false,
      });
      throw new Error('temporary connection failure');
    });

    await expect(recognition.recognize(domain)).rejects.toThrow(
      'temporary connection failure',
    );
    expect(await activeNamespace()).toMatchObject({
      trustLevel: 'establishing',
      peerAcceptanceConfirmed: false,
      remoteServiceReachable: false,
    });

    request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          status: 'recognized',
          peerAssignedLocalNamespaceId: 37,
        }),
        { status: 200 },
      ),
    );
    await recognition.recognize(domain);
    expect(await activeNamespace()).toMatchObject({
      trustLevel: 'available',
      peerAcceptanceConfirmed: true,
      remoteServiceReachable: true,
      peerAssignedLocalNamespaceId: 37,
    });
  });

  it.each(['available', 'degraded'] as const)(
    'accepts positive Health %s instead of a lost recognized result',
    async (status) => {
      await seedActiveNamespace({
        trustLevel: 'establishing',
        peerAcceptanceConfirmed: false,
        remoteServiceReachable: false,
      });
      const discovery = {
        resolveBase: vi
          .fn()
          .mockResolvedValue('https://atomic-recognition.test'),
        acquireRequestSlot: vi.fn().mockResolvedValue(() => undefined),
        request: vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              status,
              peerAssignedLocalNamespaceId: 38,
            }),
            { status: 200 },
          ),
        ),
      };
      const recognition = new FederationRecognitionService(
        database,
        discovery as never,
        { signOutbound: vi.fn().mockResolvedValue({}) } as never,
        { get: () => ({ callTimeoutSec: 12 }) } as never,
        namespaceService(),
        { emit: () => undefined } as never,
      );

      await expect(recognition.checkHealth(domain)).resolves.toBe(status);
      expect(await activeNamespace()).toMatchObject({
        trustLevel: 'available',
        peerAcceptanceConfirmed: true,
        remoteServiceReachable: true,
        peerAssignedLocalNamespaceId: 38,
      });
    },
  );

  it('counts only the available to degraded transition', async () => {
    await seedActiveNamespace();
    const recognition = service();

    await recognition.markTransportDegraded(domain, 'first failure');
    await recognition.markTransportDegraded(domain, 'retry failure');

    expect(await activeNamespace()).toMatchObject({
      trustLevel: 'degraded',
      remoteServiceReachable: false,
      degradationCount: 1,
      degradationReason: 'retry failure',
    });
  });
});
