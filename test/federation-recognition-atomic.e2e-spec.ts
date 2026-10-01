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
  identityNamespace,
} from '../src/database/schema.js';
import type { WellKnownDoc } from '../src/federation/discovery.service.js';
import { FederationNamespaceService } from '../src/federation/federation-namespace.service.js';
import { FederationRecognitionService } from '../src/federation/federation-recognition.service.js';
import { BusinessCode } from '../src/common/business-code.js';

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
        rootKeyFingerprint: 'test-fingerprint',
        identityPinnedAt: new Date(),
        active: true,
        trustLevel: 'available',
        recognizesPeer: true,
        peerAcceptanceConfirmed: true,
        localServiceAvailable: true,
        remoteServiceReachable: true,
        ...values,
      })
      .returning({ id: identityNamespace.id });
    return namespace!;
  }

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

  it('rejects a conflicting sender-assigned local namespace on an existing recognition', async () => {
    await seedActiveNamespace({
      peerAssignedLocalNamespaceId: 900,
    });

    await expect(
      service().acceptInbound(domain, document, 901),
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

    await service().acceptInbound(domain, document, 901);

    expect(await activeNamespace()).toMatchObject({
      trustLevel: 'available',
      peerAssignedLocalNamespaceId: 901,
    });
  });

  it('rolls back the recognition fact when namespace initialization fails', async () => {
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
      expect(await activeNamespace()).toMatchObject({
        trustLevel: 'establishing',
        recognizesPeer: true,
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
        new FederationNamespaceService(database),
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
