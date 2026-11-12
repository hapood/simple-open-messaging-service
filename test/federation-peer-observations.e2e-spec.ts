import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  federationFeedState,
  identityNamespace,
} from '../src/database/schema.js';
import { FederationRecognitionService } from '../src/federation/federation-recognition.service.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('peer runtime observations', () => {
  let database: DatabaseService;
  beforeAll(() => {
    database = new DatabaseService();
  });
  afterAll(async () => {
    await database.onApplicationShutdown();
  });

  async function fixture(domain: string, request: () => Promise<unknown>) {
    const id = await seedFederatedPeerNamespace(database.db, domain);
    await database.db
      .update(identityNamespace)
      .set({ localServiceAvailable: true })
      .where(eq(identityNamespace.id, id));
    await database.db
      .update(federationFeedState)
      .set({
        inboundStateFeedPulledThrough: 13n,
        stateFeedSourceGeneratedAt: 1234,
        inboundProfileNamespaceFeedPulledThrough: 27n,
        profileNamespaceFeedSourceGeneratedAt: 5678,
      })
      .where(eq(federationFeedState.namespaceId, id));
    const service = new FederationRecognitionService(
      database,
      {
        resolveBase: async () => `https://${domain}`,
        acquireRequestSlot: async () => () => {},
        request,
      } as never,
      { signOutbound: async () => ({}) } as never,
      {} as never,
      {
        recordPeerAssignedLocalNamespaceInTx: async () => {},
        activateVerifiedInTx: async () => ({ namespaceId: id, domain }),
      } as never,
      { emit: vi.fn() } as never,
    );
    const read = () =>
      database.db.query.federationFeedState.findFirst({
        where: eq(federationFeedState.namespaceId, id),
      });
    return { id, service, read };
  }

  it('persists manual and automatic outcomes without changing consumption', async () => {
    let fails = false;
    const { service, read } = await fixture(
      'health-observation.test',
      async () => {
        if (fails) throw new Error('network timeout');
        return {
          status: 200,
          json: async () => ({
            code: 0,
            message: 'successful',
            data: { status: 'degraded', peerAssignedLocalNamespaceId: 44 },
          }),
        };
      },
    );
    await expect(
      service.checkHealth('health-observation.test', 'manual'),
    ).resolves.toBe('degraded');
    expect((await read())?.latestHealthCheck).toMatchObject({
      status: 'degraded',
      error: null,
      source: 'manual',
    });
    fails = true;
    await expect(
      service.checkHealth('health-observation.test'),
    ).rejects.toThrow('network timeout');
    const row = (await read())!;
    expect(row.latestHealthCheck).toMatchObject({
      status: null,
      error: 'network timeout',
      source: 'automatic',
    });
    expect(row.latestHealthCheck!.durationMs).toBeGreaterThanOrEqual(0);
    expect(row).toMatchObject({
      lastHandshakeAt: null,
      inboundStateFeedPulledThrough: 13n,
      stateFeedSourceGeneratedAt: 1234,
      inboundProfileNamespaceFeedPulledThrough: 27n,
      profileNamespaceFeedSourceGeneratedAt: 5678,
    });
  });

  it('records completed inbound handshakes without resetting feed progress', async () => {
    const { id, service, read } = await fixture(
      'handshake-observation.test',
      async () => {
        throw new Error('unexpected network');
      },
    );
    const peer = (await database.db.query.identityNamespace.findFirst({
      where: eq(identityNamespace.id, id),
    }))!;
    await service.acceptInbound(
      peer.domain,
      peer.rootPublicKey!,
      peer.signingKeyCreatedAt,
    );
    expect(await read()).toMatchObject({
      lastHandshakeAt: expect.any(Date),
      inboundStateFeedPulledThrough: 13n,
      stateFeedSourceGeneratedAt: 1234,
      inboundProfileNamespaceFeedPulledThrough: 27n,
      profileNamespaceFeedSourceGeneratedAt: 5678,
    });
  });

  it('rejects stale health effects and observations after an in-flight identity change', async () => {
    let complete!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const { id, service, read } = await fixture('health-epoch.test', () => {
      entered();
      return new Promise((resolve) => {
        complete = resolve;
      });
    });
    const pending = service.checkHealth('health-epoch.test');
    await started;
    await database.db
      .update(identityNamespace)
      .set({
        rootPublicKey: Buffer.alloc(32, 91).toString('base64'),
        remoteServiceReachable: false,
      })
      .where(eq(identityNamespace.id, id));
    complete({
      status: 200,
      json: async () => ({
        code: 0,
        message: 'successful',
        data: { status: 'available', peerAssignedLocalNamespaceId: 44 },
      }),
    });
    await pending;
    expect((await read())?.latestHealthCheck).toBeNull();
    const peer = await database.db.query.identityNamespace.findFirst({
      where: eq(identityNamespace.id, id),
    });
    expect(peer?.remoteServiceReachable).toBe(false);
  });
});
