import { describe, expect, it, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import * as tables from '../database/schema.js';
import { FEDERATION_PEER_AVAILABLE } from './federation-peer.events.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { S2sRecognitionController } from './s2s-recognition.controller.js';

process.env.SOMS_DOMAIN ??= 'local.example';

const TEST_ROOT_KEY = Buffer.alloc(32, 2).toString('base64');
const OTHER_ROOT_KEY = Buffer.alloc(32, 9).toString('base64');

/** Drizzle select-chain mock resolving rows (or none) at limit(). */
function selectChain(rows: unknown[]) {
  const builder: Record<string, unknown> = {};
  for (const method of ['from', 'innerJoin', 'where', 'orderBy', 'for'])
    builder[method] = vi.fn(() => builder);
  builder.limit = vi.fn(async () => rows);
  return builder;
}

describe('S2sRecognitionController Health privacy projection', () => {
  function target(options: { namespaceRows?: unknown[] } = {}) {
    const discovery = {
      fetchWellKnown: vi.fn(),
      getCachedPublicKey: vi.fn(),
      cacheDocument: vi.fn().mockResolvedValue(undefined),
    };
    const verify = {
      extractHeaders: vi.fn().mockReturnValue({
        's2s-root-key': TEST_ROOT_KEY,
      }),
      parseSigner: vi.fn().mockReturnValue({
        keyId: 'peer.example/key-2',
        domain: 'peer.example',
        expires: Math.floor(Date.now() / 1000) + 300,
      }),
      signedRequest: vi.fn().mockReturnValue({
        method: 'POST',
        url: new URL('https://local.example/s2s/v1/recognize'),
        body: '{}',
      }),
      verifyWithPublicKey: vi.fn(),
    };
    const recognition = {
      hasPreparedPeer: vi.fn().mockResolvedValue(true),
      captureVerifiedContext: vi.fn().mockResolvedValue({
        namespaceId: 12,
        peerAssignedLocalNamespaceId: 7,
      }),
      acceptInbound: vi.fn(),
      submitInboundRecognize: vi.fn().mockResolvedValue({
        status: 'pending',
        message: 'verification in progress',
      }),
      queryHealth: vi.fn(),
      markReachable: vi.fn().mockResolvedValue(undefined),
    };
    const database = {
      db: {
        select: vi.fn(() =>
          selectChain(
            options.namespaceRows ?? [
              { domain: 'peer.example', namespaceId: 12 },
            ],
          ),
        ),
      },
    };
    const controller = new S2sRecognitionController(
      { assertAvailable: vi.fn() } as never,
      verify as never,
      discovery as never,
      recognition as never,
      database as never,
    );
    return { controller, discovery, verify, recognition, database };
  }

  const healthRequest = {
    url: '/s2s/v1/health',
    rawBody: Buffer.alloc(0),
    headers: {},
  } as never;

  it('answers a cache miss with the uniform unavailable status and never fetches well-known', async () => {
    const { controller, discovery, verify, recognition } = target();
    discovery.getCachedPublicKey.mockResolvedValue(null);

    await expect(controller.health(healthRequest)).resolves.toEqual({
      code: 0,
      message: 'successful',
      data: { status: 'unavailable' },
    });
    expect(discovery.getCachedPublicKey).toHaveBeenCalledWith(
      'peer.example',
      12,
      'peer.example/key-2',
    );
    expect(discovery.fetchWellKnown).not.toHaveBeenCalled();
    expect(verify.verifyWithPublicKey).not.toHaveBeenCalled();
    expect(recognition.queryHealth).not.toHaveBeenCalled();
  });

  it('maps an unresolvable claimed root to the uniform unavailable status', async () => {
    const { controller, discovery } = target({ namespaceRows: [] });

    await expect(controller.health(healthRequest)).resolves.toEqual({
      code: 0,
      message: 'successful',
      data: { status: 'unavailable' },
    });
    expect(discovery.getCachedPublicKey).not.toHaveBeenCalled();
    expect(discovery.fetchWellKnown).not.toHaveBeenCalled();
  });

  it('maps a malformed S2S-Root-Key to the uniform unavailable status', async () => {
    const { controller, discovery, verify } = target();
    verify.extractHeaders.mockReturnValue({ 's2s-root-key': 'not-base64' });

    await expect(controller.health(healthRequest)).resolves.toEqual({
      code: 0,
      message: 'successful',
      data: { status: 'unavailable' },
    });
    expect(discovery.getCachedPublicKey).not.toHaveBeenCalled();
  });

  it('maps a failed signature verification to the uniform unavailable status', async () => {
    const { controller, discovery, verify, recognition } = target();
    discovery.getCachedPublicKey.mockResolvedValue(new Uint8Array(32));
    verify.verifyWithPublicKey.mockRejectedValue(
      new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        'signature verification failed',
        401,
      ),
    );

    await expect(controller.health(healthRequest)).resolves.toEqual({
      code: 0,
      message: 'successful',
      data: { status: 'unavailable' },
    });
    expect(recognition.queryHealth).not.toHaveBeenCalled();
    expect(recognition.markReachable).not.toHaveBeenCalled();
  });

  it('returns unavailable after authentication when the peer has no prepared receive path', async () => {
    const { controller, discovery, verify, recognition } = target();
    discovery.getCachedPublicKey.mockResolvedValue(new Uint8Array(32));
    recognition.hasPreparedPeer.mockResolvedValue(false);

    await expect(controller.health(healthRequest)).resolves.toEqual({
      code: 0,
      message: 'successful',
      data: { status: 'unavailable' },
    });
    expect(verify.verifyWithPublicKey).toHaveBeenCalledOnce();
    expect(recognition.queryHealth).not.toHaveBeenCalled();
    expect(recognition.markReachable).not.toHaveBeenCalled();
  });

  it('returns the admission status before refreshing authenticated reachability', async () => {
    const { controller, discovery, recognition } = target();
    discovery.getCachedPublicKey.mockResolvedValue(new Uint8Array(32));
    recognition.queryHealth.mockResolvedValue('degraded');

    await expect(controller.health(healthRequest)).resolves.toEqual({
      code: 0,
      message: 'successful',
      data: { status: 'degraded', peerAssignedLocalNamespaceId: 12 },
    });

    expect(recognition.queryHealth).toHaveBeenCalledBefore(
      recognition.markReachable,
    );
    expect(recognition.markReachable).toHaveBeenCalledWith('peer.example');
  });

  it.each([
    {
      url: '/s2s/v1/health?domain=peer.example',
      rawBody: Buffer.alloc(0),
      headers: {},
    },
    {
      url: '/s2s/v1/health',
      rawBody: Buffer.from('{}'),
      headers: {},
    },
    {
      url: '/s2s/v1/health',
      rawBody: Buffer.alloc(0),
      headers: { 'content-type': 'application/json' },
    },
  ])(
    'rejects GET metadata left over from the former POST shape',
    async (req) => {
      const { controller, verify } = target();

      await expect(controller.health(req as never)).rejects.toMatchObject({
        bizCode: BusinessCode.FEDERATION_MALFORMED,
        status: 400,
      });
      expect(verify.extractHeaders).not.toHaveBeenCalled();
    },
  );

  it('rejects the removed recognize domain field', async () => {
    const { controller, discovery } = target();

    await expect(
      controller.recognize({} as never, { domain: 'peer.example' }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
    expect(discovery.fetchWellKnown).not.toHaveBeenCalled();
  });

  it('rejects a missing S2S-Root-Key on Recognize', async () => {
    const { controller, verify, recognition } = target();
    verify.extractHeaders.mockReturnValue({});

    await expect(controller.recognize({} as never, {})).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_MALFORMED,
      status: 400,
    });
    expect(recognition.submitInboundRecognize).not.toHaveBeenCalled();
  });

  it('accepts Recognize into asynchronous verification with the claimed root', async () => {
    const { controller, discovery, recognition } = target();

    await expect(
      controller.recognize(
        {
          ip: '192.0.2.42',
          headers: { 'x-forwarded-for': '198.51.100.99' },
        } as never,
        { namespaceId: 5 },
      ),
    ).resolves.toEqual({
      code: 0,
      message: 'successful',
      data: { status: 'pending', message: 'verification in progress' },
    });
    expect(discovery.fetchWellKnown).not.toHaveBeenCalled();
    expect(recognition.submitInboundRecognize).toHaveBeenCalledWith({
      requestIp: '192.0.2.42',
      domain: 'peer.example',
      keyId: 'peer.example/key-2',
      claimedRoot: TEST_ROOT_KEY,
      signedRequest: expect.anything(),
      headers: { 's2s-root-key': TEST_ROOT_KEY },
      senderAssignedLocalNamespaceId: 5,
      signatureExpires: expect.any(Number),
    });
  });
});

describe('FederationRecognitionService health transitions', () => {
  function service() {
    const events = { emit: vi.fn() };
    const recognition = new FederationRecognitionService(
      {} as never,
      {} as never,
      {} as never,
      { get: () => ({ callTimeoutSec: 12 }) } as never,
      {} as never,
      events as never,
    );
    return { recognition, events };
  }

  it('replays the latest recognition stage to re-entrant subscribers', () => {
    const { recognition } = service();
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = recognition.subscribeProgress(
      'peer.example',
      first,
    );
    (
      recognition as unknown as {
        publishProgress(domain: string, stage: 'CONNECTING'): void;
      }
    ).publishProgress('peer.example', 'CONNECTING');

    const unsubscribeSecond = recognition.subscribeProgress(
      'peer.example',
      second,
    );

    expect(first).toHaveBeenLastCalledWith('CONNECTING');
    expect(second).toHaveBeenCalledExactlyOnceWith('CONNECTING');
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('requires acceptance before deriving availability from reachability', () => {
    const { recognition } = service();
    const lifecycle = (
      recognition as unknown as {
        lifecycle(peer: Record<string, unknown>): string;
      }
    ).lifecycle.bind(recognition);
    const prepared = {
      trustLevel: 'establishing',
      identityPinnedAt: new Date(),
      localServiceAvailable: true,
      peerAcceptanceConfirmed: false,
    };

    expect(lifecycle({ ...prepared, remoteServiceReachable: false })).toBe(
      'establishing',
    );
    expect(lifecycle({ ...prepared, remoteServiceReachable: true })).toBe(
      'establishing',
    );
    expect(
      lifecycle({
        ...prepared,
        peerAcceptanceConfirmed: true,
        remoteServiceReachable: false,
      }),
    ).toBe('degraded');
    expect(
      lifecycle({
        ...prepared,
        peerAcceptanceConfirmed: true,
        remoteServiceReachable: true,
      }),
    ).toBe('available');
  });

  it('degrades local availability when Health returns unavailable', async () => {
    const service = new FederationRecognitionService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const degrade = vi
      .spyOn(service, 'markTransportDegraded')
      .mockResolvedValue(undefined);

    await service.applyHealthResult('peer.example', 'unavailable');

    expect(degrade).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
      'Health unavailable',
      undefined,
      undefined,
    );
  });

  it('marks reachability lost when Health discovery fails', async () => {
    const { database } = txDatabase({ id: 12, active: true, rootPublicKey: 'root-a' });
    const recognition = new FederationRecognitionService(
      database as never,
      {
        resolveBase: vi.fn().mockRejectedValue(new Error('DNS timeout')),
      } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const degrade = vi
      .spyOn(recognition, 'markTransportDegraded')
      .mockResolvedValue(undefined);

    await expect(recognition.checkHealth('peer.example')).rejects.toThrow(
      'DNS timeout',
    );
    expect(degrade).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
      'Health discovery: DNS timeout',
      undefined,
      expect.objectContaining({ id: 12 }),
    );
  });

  function txDatabase(peer?: Record<string, unknown>) {
    const updateValues = vi.fn();
    const insertValues = vi.fn();
    const tx = {
      // Fake drizzle builder for lockPeer's SELECT chain: every chained call returns the same
      // builder; `limit` resolves the seeded peer row (or none), as `…FOR UPDATE LIMIT 1` would.
      select: vi.fn(() => {
        const builder: Record<string, unknown> = {};
        for (const method of ['from', 'leftJoin', 'where', 'for'])
          builder[method] = vi.fn(() => builder);
        builder.limit = vi.fn(async () => (peer ? [peer] : []));
        return builder;
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn((values: unknown) => {
          updateValues(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
      insert: vi.fn().mockImplementation(() => ({
        values: vi.fn((values: unknown) => {
          insertValues(values);
          return Promise.resolve();
        }),
      })),
    };
    const database = {
      db: {
        query: { identityNamespace: { findFirst: async () => peer } },
        transaction: vi.fn(
          async (operation: (value: typeof tx) => Promise<void>) =>
            operation(tx),
        ),
      },
    };
    return { database, updateValues, insertValues };
  }

  it.each(['available', 'degraded'] as const)(
    'confirms peer recognition when Health returns %s',
    async (status) => {
      const { database, updateValues } = txDatabase({
        trustLevel: 'establishing',
        identityPinnedAt: new Date(),
        localServiceAvailable: true,
        peerAcceptanceConfirmed: false,
      });
      const events = { emit: vi.fn() };
      const recognition = new FederationRecognitionService(
        database as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        events as never,
      );

      await recognition.applyHealthResult('peer.example', status);

      expect(updateValues).toHaveBeenCalledWith(
        expect.objectContaining({
          peerAcceptanceConfirmed: true,
          remoteServiceReachable: true,
        }),
      );
      expect(events.emit).toHaveBeenCalledExactlyOnceWith(
        FEDERATION_PEER_AVAILABLE,
        { peerDomain: 'peer.example' },
      );
    },
  );

  it('audits the recovery when Health restores a degraded peer', async () => {
    const { database, insertValues } = txDatabase({
      trustLevel: 'degraded',
      identityPinnedAt: new Date(),
      localServiceAvailable: true,
      peerAcceptanceConfirmed: true,
    });
    const events = { emit: vi.fn() };
    const recognition = new FederationRecognitionService(
      database as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      events as never,
    );

    await recognition.applyHealthResult('peer.example', 'available');

    expect(insertValues).not.toHaveBeenCalled();
    expect(events.emit).toHaveBeenCalledExactlyOnceWith(
      FEDERATION_PEER_AVAILABLE,
      { peerDomain: 'peer.example' },
    );
  });

  it('emits no recovery event when the peer was already available', async () => {
    const { database, insertValues } = txDatabase({
      trustLevel: 'available',
      identityPinnedAt: new Date(),
      localServiceAvailable: true,
      peerAcceptanceConfirmed: true,
    });
    const events = { emit: vi.fn() };
    const recognition = new FederationRecognitionService(
      database as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      events as never,
    );

    await recognition.applyHealthResult('peer.example', 'available');

    expect(events.emit).not.toHaveBeenCalled();
    expect(insertValues).not.toHaveBeenCalled();
  });

  it('coalesces concurrent Health checks for the same domain', async () => {
    // Park the very first network step so the in-flight run is visible; coalescing means the
    // second checkHealth() reuses it instead of issuing its own resolveBase round.
    let releaseBase!: (base: string) => void;
    const blocked = new Promise<string>((resolve) => {
      releaseBase = resolve;
    });
    const discovery = {
      resolveBase: vi.fn(() => blocked),
      acquireRequestSlot: vi.fn(async () => () => {}),
      request: vi.fn(async () => ({
        status: 200,
        json: async () => ({
          code: 0,
          message: 'successful',
          data: { status: 'available', peerAssignedLocalNamespaceId: 44 },
        }),
      })),
    };
    const { database } = txDatabase({ id: 12, active: true, rootPublicKey: 'root-a', identityPinnedAt: new Date(), localServiceAvailable: true });
    const namespaces = {
      captureVerifiedInTx: vi.fn().mockResolvedValue({ namespaceId: 12 }),
      recordPeerAssignedLocalNamespaceInTx: vi
        .fn()
        .mockResolvedValue(undefined),
    };
    const recognition = new FederationRecognitionService(
      database as never,
      discovery as never,
      { signOutbound: vi.fn(async () => ({})) } as never,
      { get: () => ({ callTimeoutSec: 12 }) } as never,
      namespaces as never,
      { emit: vi.fn() } as never,
    );

    const first = recognition.checkHealth('peer.example');
    const second = recognition.checkHealth('peer.example');

    await vi.waitFor(() => expect(discovery.resolveBase).toHaveBeenCalledExactlyOnceWith('peer.example'));
    releaseBase('http://127.0.0.1:1');
    await expect(Promise.all([first, second])).resolves.toEqual([
      'available',
      'available',
    ]);
    expect(
      namespaces.recordPeerAssignedLocalNamespaceInTx,
    ).toHaveBeenCalledWith(expect.anything(), 'peer.example', 44);
  });
});

describe('FederationRecognitionService inbound Recognize result states', () => {
  /** Harness for the staged answer path: the recognized / halted / retired
   *  lookups are dispatched by their projected columns, and the three
   *  selects (domain epoch, root epoch, review) are queued in call order. */
  function subject(
    options: {
      review?: Record<string, unknown> | null;
      domainEpoch?: unknown[];
      rootEpoch?: unknown[];
      reviewRows?: unknown[];
      recognizedPeer?: Record<string, unknown> | null;
      haltedPeer?: Record<string, unknown> | null;
      retiredIdentity?: Record<string, unknown> | null;
    } = {},
  ) {
    const selectRows = [
      [], // Persisted verified conflicts.
      options.domainEpoch ?? [],
      options.rootEpoch ?? [],
      options.reviewRows ?? (options.review ? [options.review] : []),
    ];
    let selectCall = 0;
    const database = {
      db: {
        select: vi.fn(() => {
          const rows = selectRows[Math.min(selectCall, selectRows.length - 1)]!;
          selectCall += 1;
          return selectChain(rows);
        }),
        query: {
          identityNamespace: {
            findFirst: vi.fn(
              async (args?: { columns?: Record<string, unknown> }) => {
                const columns = Object.keys(args?.columns ?? {});
                if (columns.includes('peerAcceptanceConfirmed'))
                  return options.recognizedPeer ?? null;
                if (columns.includes('haltCode'))
                  return options.haltedPeer ?? null;
                if (columns.length === 1 && columns[0] === 'id')
                  return options.retiredIdentity ?? null;
                return null;
              },
            ),
          },
        },
      },
    };
    const service = new FederationRecognitionService(
      database as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const verify = vi
      .spyOn(
        service as unknown as Record<string, (...args: unknown[]) => unknown>,
        'verifyInboundRecognize',
      )
      .mockResolvedValue(undefined);
    return { service, verify, database };
  }

  const signedRequest = {
    method: 'POST' as const,
    url: new URL('https://local.example/s2s/v1/recognize'),
    body: '{}',
  };
  const recognizeHeaders = {
    date: new Date().toUTCString(),
    'content-digest': 'sha-256=:test:',
    'signature-input':
      'sig1=("@method");created=1;expires=2;keyid="peer.example/key-1"',
    signature: 'sig1=:test:',
    's2s-root-key': TEST_ROOT_KEY,
  };

  it('refuses an arrival claiming a retired identity root without re-verification', async () => {
    const { service, verify } = subject({ retiredIdentity: { id: 5 } });

    await expect(
      service.submitInboundRecognize({
        requestIp: '192.0.2.1',
        domain: 'peer.example',
        keyId: 'peer.example/key-1',
        claimedRoot: TEST_ROOT_KEY,
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_BLOCKED,
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('refuses a retired identity even when a stale review still matches the domain', async () => {
    const { service, verify } = subject({
      retiredIdentity: { id: 5 },
      review: {
        kind: 'root-rotation',
        status: 'rejected',
        claim: { previousRoot: OTHER_ROOT_KEY },
      },
    });

    await expect(
      service.submitInboundRecognize({
        requestIp: '192.0.2.1',
        domain: 'peer.example',
        keyId: 'peer.example/key-1',
        claimedRoot: TEST_ROOT_KEY,
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_BLOCKED,
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('answers a recognized arrival even while a review for another root is open', async () => {
    const { service, verify, database } = subject({
      recognizedPeer: {
        id: 7,
        peerAssignedLocalNamespaceId: 9,
        peerAcceptanceConfirmed: true,
        localServiceAvailable: true,
        trustLevel: 'available',
      },
      // An open rotation review for a different claimed root must not mask
      // the committed relationship of the still-pinned root.
      review: {
        kind: 'root-rotation',
        status: 'pending',
        claim: { previousRoot: OTHER_ROOT_KEY },
      },
    });

    await expect(
      service.submitInboundRecognize({
        requestIp: '192.0.2.1',
        domain: 'peer.example',
        keyId: 'peer.example/key-1',
        claimedRoot: TEST_ROOT_KEY,
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).resolves.toEqual({
      status: 'recognized',
      peerAssignedLocalNamespaceId: 7,
    });
    expect(verify).not.toHaveBeenCalled();
    expect(database.db.select).not.toHaveBeenCalled();
  });

  it('returns pending when an open review is waiting for administrator approval', async () => {
    const { service, verify } = subject({
      rootEpoch: [
        { id: 7, domain: 'old.example', peerAssignedLocalNamespaceId: null },
      ],
      review: {
        kind: 'domain-rebind',
        status: 'pending',
        claim: { previousDomain: 'old.example' },
      },
    });

    await expect(
      service.submitInboundRecognize({
        requestIp: '192.0.2.1',
        domain: 'Peer.Example.',
        keyId: 'peer.example/key-1',
        claimedRoot: TEST_ROOT_KEY,
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).resolves.toEqual({
      status: 'pending',
      message: 'waiting for administrator approval',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns the rotation rejection code for a rejected root-rotation review', async () => {
    const { service, verify } = subject({
      domainEpoch: [
        {
          id: 7,
          domain: 'peer.example',
          rootPublicKey: OTHER_ROOT_KEY,
          peerAssignedLocalNamespaceId: null,
        },
      ],
      review: {
        kind: 'root-rotation',
        status: 'rejected',
        claim: { previousRoot: OTHER_ROOT_KEY },
      },
    });

    await expect(
      service.submitInboundRecognize({
        requestIp: '192.0.2.1',
        domain: 'peer.example',
        keyId: 'peer.example/key-1',
        claimedRoot: TEST_ROOT_KEY,
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).resolves.toEqual({
      code: BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
      message: 'root rotation rejected by administrator review',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns the re-binding rejection code for a rejected domain-rebind review', async () => {
    const { service, verify } = subject({
      rootEpoch: [
        { id: 7, domain: 'old.example', peerAssignedLocalNamespaceId: null },
      ],
      review: {
        kind: 'domain-rebind',
        status: 'rejected',
        claim: { previousDomain: 'old.example' },
      },
    });

    await expect(
      service.submitInboundRecognize({
        requestIp: '192.0.2.1',
        domain: 'peer.example',
        keyId: 'peer.example/key-1',
        claimedRoot: TEST_ROOT_KEY,
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).resolves.toEqual({
      code: BusinessCode.FEDERATION_DOMAIN_CHANGE_REJECTED,
      message: 'domain re-binding rejected by administrator review',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('does not serve a rejection recorded for a different origin pin', async () => {
    // The review was recorded when the epoch pinned a different root; the
    // live pin has since moved, so this arrival is a fresh proposal and must
    // be re-verified instead of inheriting the old rejection.
    const { service, verify } = subject({
      domainEpoch: [
        {
          id: 7,
          domain: 'peer.example',
          rootPublicKey: OTHER_ROOT_KEY,
          peerAssignedLocalNamespaceId: null,
        },
      ],
      review: {
        kind: 'root-rotation',
        status: 'rejected',
        claim: { previousRoot: 'stale-origin-root' },
      },
    });

    await expect(
      service.submitInboundRecognize({
        requestIp: '192.0.2.1',
        domain: 'peer.example',
        keyId: 'peer.example/key-1',
        claimedRoot: TEST_ROOT_KEY,
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).resolves.toEqual({
      status: 'pending',
      message: 'verification in progress',
    });
    expect(verify).toHaveBeenCalledOnce();
  });

  /** Database mock for verifyInboundRecognize resolution paths: rows for the
   *  domain epoch lookup, the root epoch lookup, and optional review writes. */
  function resolutionTarget(options: {
    domainEpoch?: unknown[];
    rootEpoch?: unknown[];
  }) {
    const reviewInsert = vi.fn();
    const namespaceUpdate = vi.fn().mockResolvedValue(undefined);
    let call = 0;
    const rowsPerCall = [options.domainEpoch ?? [], options.rootEpoch ?? []];
    const database = {
      db: {
        select: vi.fn(() => {
          const rows = rowsPerCall[Math.min(call, rowsPerCall.length - 1)]!;
          call += 1;
          return selectChain(rows);
        }),
        update: vi.fn(() => ({
          set: vi.fn((patch: unknown) => ({
            where: vi.fn(() => namespaceUpdate(patch)),
          })),
        })),
        insert: vi.fn((table: unknown) => ({
          values: vi.fn((values: unknown) => {
            if (table === tables.federationIdentityReview) {
              reviewInsert(values);
              return { onConflictDoUpdate: vi.fn() };
            }
            return Promise.resolve();
          }),
        })),
      },
    };
    const transactionInsert = vi.fn(database.db.insert);
    const transactionUpdate = vi.fn(database.db.update);
    const transaction = vi.fn(async (run: (tx: unknown) => Promise<void>) =>
      run({
        insert: transactionInsert,
        update: transactionUpdate,
        select: () => selectChain(options.domainEpoch ?? []),
      }),
    );
    Object.assign(database.db, { transaction });
    const doc = {
      protocolVersions: [1],
      signingKeyCreatedAt: 1700000000000,
      roots: [
        {
          ed25519: TEST_ROOT_KEY,
          notBefore: Date.now() - 10_000,
          notAfter: Date.now() + 10_000,
        },
      ],
      keys: [
        {
          keyId: 'peer.example/key-1',
          ed25519: Buffer.alloc(32, 3).toString('base64'),
          root: TEST_ROOT_KEY,
          notBefore: Date.now() - 1000,
          notAfter: Date.now() + 1000,
        },
      ],
    };
    const discovery = {
      fetchWellKnown: vi.fn().mockResolvedValue(doc),
      cacheDocument: vi.fn().mockResolvedValue(undefined),
    };
    const signature = { verifyWithKey: vi.fn().mockResolvedValue(true) };
    const service = new FederationRecognitionService(
      database as never,
      discovery as never,
      signature as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const acceptInbound = vi.spyOn(service, 'acceptInbound').mockResolvedValue({
      domain: 'peer.example',
      namespaceId: 9,
      peerAssignedLocalNamespaceId: null,
      rootPublicKey: TEST_ROOT_KEY,
    } as never);
    const verify = (
      service as unknown as {
        verifyInboundRecognize: (params: {
          domain: string;
          keyId: string;
          claimedRoot: string;
          signedRequest: typeof signedRequest;
          headers: typeof recognizeHeaders;
          signatureExpires: number;
          senderAssignedLocalNamespaceId?: number;
        }) => Promise<void>;
      }
    ).verifyInboundRecognize.bind(service);
    return {
      service,
      verify,
      acceptInbound,
      reviewInsert,
      namespaceUpdate,
      transaction,
      transactionInsert,
      transactionUpdate,
    };
  }

  it('halts and opens an identity-reset review when the verified group dropped the pin', async () => {
    const target = resolutionTarget({
      domainEpoch: [
        {
          id: 7,
          domain: 'peer.example',
          rootPublicKey: OTHER_ROOT_KEY,
          peerAssignedLocalNamespaceId: null,
        },
      ],
    });
    await expect(
      target.verify({
        domain: 'peer.example',
        keyId: 'peer.example/key-1',
        claimedRoot: TEST_ROOT_KEY,
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
    });
    expect(target.reviewInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'identity-reset',
        matchedNamespaceId: 7,
        claimedRoot: TEST_ROOT_KEY,
      }),
    );
    expect(target.namespaceUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        trustLevel: 'halted',
        haltCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      }),
    );
    expect(target.transaction).toHaveBeenCalledOnce();
  });

  it('commits an ordinary first recognition without a review record', async () => {
    const target = resolutionTarget({ domainEpoch: [], rootEpoch: [] });

    await target.verify({
      domain: 'Peer.Example.',
      keyId: 'peer.example/key-1',
      claimedRoot: TEST_ROOT_KEY,
      signedRequest,
      headers: recognizeHeaders,
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
      senderAssignedLocalNamespaceId: 44,
    });

    expect(target.acceptInbound).toHaveBeenCalledWith(
      'peer.example',
      TEST_ROOT_KEY,
      1700000000000,
      44,
    );
    expect(target.reviewInsert).not.toHaveBeenCalled();
  });

  it('commits an ordinary re-recognition when the claimed root is pinned for the domain', async () => {
    const target = resolutionTarget({
      domainEpoch: [
        {
          id: 9,
          domain: 'peer.example',
          rootPublicKey: TEST_ROOT_KEY,
          peerAssignedLocalNamespaceId: 44,
        },
      ],
      rootEpoch: [
        {
          id: 9,
          domain: 'peer.example',
          peerAssignedLocalNamespaceId: 44,
        },
      ],
    });

    await target.verify({
      domain: 'peer.example',
      keyId: 'peer.example/key-1',
      claimedRoot: TEST_ROOT_KEY,
      signedRequest,
      headers: recognizeHeaders,
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
      senderAssignedLocalNamespaceId: 44,
    });

    expect(target.acceptInbound).toHaveBeenCalledWith(
      'peer.example',
      TEST_ROOT_KEY,
      1700000000000,
      44,
    );
    expect(target.reviewInsert).not.toHaveBeenCalled();
  });

  it('keeps a live epoch arriving under a different domain pending for review', async () => {
    const target = resolutionTarget({
      domainEpoch: [],
      rootEpoch: [
        { id: 7, domain: 'old.example', peerAssignedLocalNamespaceId: null },
      ],
    });

    await target.verify({
      domain: 'peer.example',
      keyId: 'peer.example/key-1',
      claimedRoot: TEST_ROOT_KEY,
      signedRequest,
      headers: recognizeHeaders,
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
    });

    expect(target.acceptInbound).not.toHaveBeenCalled();
    expect(target.reviewInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'domain-rebind',
        matchedNamespaceId: 7,
        nextDomain: 'peer.example',
        claimedRoot: TEST_ROOT_KEY,
        status: 'pending',
      }),
    );
    expect(target.namespaceUpdate).not.toHaveBeenCalled();
    expect(target.transaction).toHaveBeenCalledOnce();
    expect(target.transactionInsert).toHaveBeenCalledExactlyOnceWith(
      tables.federationIdentityReview,
    );
    expect(target.transactionUpdate).not.toHaveBeenCalled();
  });

  it('keeps a live epoch arriving under a different domain pending despite a new coordinate', async () => {
    const target = resolutionTarget({
      domainEpoch: [],
      rootEpoch: [
        { id: 7, domain: 'old.example', peerAssignedLocalNamespaceId: 1 },
      ],
    });

    await target.verify({
      domain: 'peer.example',
      keyId: 'peer.example/key-1',
      claimedRoot: TEST_ROOT_KEY,
      signedRequest,
      headers: recognizeHeaders,
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
      senderAssignedLocalNamespaceId: 2,
    });

    expect(target.acceptInbound).not.toHaveBeenCalled();
    expect(target.reviewInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'domain-rebind',
        matchedNamespaceId: 7,
        nextDomain: 'peer.example',
        claimedRoot: TEST_ROOT_KEY,
        status: 'pending',
        claim: expect.objectContaining({
          senderAssignedLocalNamespaceId: 2,
        }),
      }),
    );
    // The pending review quarantines the proposed address only; the existing
    // peer's acceptance and admission stay untouched.
    expect(target.namespaceUpdate).not.toHaveBeenCalled();
    expect(target.transaction).toHaveBeenCalledOnce();
    expect(target.transactionInsert).toHaveBeenCalledExactlyOnceWith(
      tables.federationIdentityReview,
    );
    expect(target.transactionUpdate).not.toHaveBeenCalled();
  });
  it('records a root rotation review when the group still contains the pin', async () => {
    const target = resolutionTarget({
      domainEpoch: [
        {
          id: 7,
          domain: 'peer.example',
          rootPublicKey: OTHER_ROOT_KEY,
          peerAssignedLocalNamespaceId: 44,
        },
      ],
      rootEpoch: [],
    });
    // The fetched group must still contain the pinned predecessor root.
    expect(target.verify).toBeDefined();
    const discoveryDoc = {
      protocolVersions: [1],
      signingKeyCreatedAt: 1700000000000,
      roots: [
        {
          ed25519: OTHER_ROOT_KEY,
          notBefore: Date.now() - 10_000,
          notAfter: Date.now() + 10_000,
        },
        {
          ed25519: TEST_ROOT_KEY,
          notBefore: Date.now() - 10_000,
          notAfter: Date.now() + 10_000,
        },
      ],
      keys: [
        {
          keyId: 'peer.example/key-1',
          ed25519: Buffer.alloc(32, 3).toString('base64'),
          root: TEST_ROOT_KEY,
          notBefore: Date.now() - 1000,
          notAfter: Date.now() + 1000,
        },
      ],
    };
    // resolutionTarget captured its discovery mock internally; rebuild with it.
    const service = (
      target as unknown as { service: FederationRecognitionService }
    ).service;
    (
      service as unknown as {
        discovery: { fetchWellKnown: ReturnType<typeof vi.fn> };
      }
    ).discovery.fetchWellKnown.mockResolvedValue(discoveryDoc);

    await target.verify({
      domain: 'peer.example',
      keyId: 'peer.example/key-1',
      claimedRoot: TEST_ROOT_KEY,
      signedRequest,
      headers: recognizeHeaders,
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
      senderAssignedLocalNamespaceId: 44,
    });

    expect(target.acceptInbound).not.toHaveBeenCalled();
    expect(target.reviewInsert).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'root-rotation',
        matchedNamespaceId: 7,
        nextDomain: 'peer.example',
        claimedRoot: TEST_ROOT_KEY,
        status: 'pending',
      }),
    );
    // A rotation review leaves the pinned epoch untouched.
    expect(target.namespaceUpdate).not.toHaveBeenCalled();
    expect(target.transaction).toHaveBeenCalledOnce();
    expect(target.transactionInsert).toHaveBeenCalledExactlyOnceWith(
      tables.federationIdentityReview,
    );
    expect(target.transactionUpdate).not.toHaveBeenCalled();
  });

  it('answers pending immediately and coalesces concurrent arrivals into one verifier', async () => {
    const { service, verify } = subject();
    let release!: () => void;
    verify.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const params = {
      requestIp: '192.0.2.1',
      domain: 'Peer.Example.',
      keyId: 'peer.example/key-1',
      claimedRoot: TEST_ROOT_KEY,
      signedRequest,
      headers: recognizeHeaders,
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
    };

    await expect(service.submitInboundRecognize(params)).resolves.toEqual({
      status: 'pending',
      message: 'verification in progress',
    });
    await expect(service.submitInboundRecognize(params)).resolves.toEqual({
      status: 'pending',
      message: 'verification in progress',
    });

    expect(verify).toHaveBeenCalledExactlyOnceWith({
      ...params,
      domain: 'peer.example',
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('answers a signature refusal only for the exact failed request evidence', async () => {
    const { service, verify } = subject();
    verify.mockRejectedValue(
      new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        'signature verification failed',
        HttpStatus.UNAUTHORIZED,
      ),
    );
    const params = {
      requestIp: '192.0.2.1',
      domain: 'peer.example',
      keyId: 'peer.example/key-1',
      claimedRoot: TEST_ROOT_KEY,
      signedRequest,
      headers: recognizeHeaders,
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
    };

    await expect(service.submitInboundRecognize(params)).resolves.toEqual({
      status: 'pending',
      message: 'verification in progress',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(service.submitInboundRecognize(params)).resolves.toEqual({
      code: BusinessCode.FEDERATION_BAD_SIGNATURE,
      message: 'signature verification failed',
    });
    expect(verify).toHaveBeenCalledOnce();
  });

  it('re-verifies the coordinate after the cooled window expires', async () => {
    vi.useFakeTimers();
    try {
      const { service, verify } = subject();
      verify.mockRejectedValue(
        new BusinessException(
          BusinessCode.FEDERATION_BAD_SIGNATURE,
          'signature verification failed',
          HttpStatus.UNAUTHORIZED,
        ),
      );
      const params = {
        requestIp: '192.0.2.1',
        domain: 'peer.example',
        keyId: 'peer.example/key-1',
        claimedRoot: TEST_ROOT_KEY,
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      };

      await expect(service.submitInboundRecognize(params)).resolves.toEqual({
        status: 'pending',
        message: 'verification in progress',
      });
      await vi.advanceTimersByTimeAsync(0);
      await expect(service.submitInboundRecognize(params)).resolves.toEqual({
        code: BusinessCode.FEDERATION_BAD_SIGNATURE,
        message: 'signature verification failed',
      });
      expect(verify).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10 * 60_000 + 1_000);
      await expect(service.submitInboundRecognize(params)).resolves.toEqual({
        status: 'pending',
        message: 'verification in progress',
      });
      expect(verify).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  function arrival(
    requestIp = '192.0.2.1',
    signature = recognizeHeaders.signature,
  ) {
    return {
      requestIp,
      domain: 'peer.example',
      keyId: 'peer.example/key-1',
      claimedRoot: TEST_ROOT_KEY,
      signedRequest,
      headers: { ...recognizeHeaders, signature },
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
    };
  }

  it('does not let a forged signature refuse fresh evidence from another IP', async () => {
    const { service, verify } = subject();
    verify.mockRejectedValueOnce(
      new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        'bad signature',
        HttpStatus.UNAUTHORIZED,
      ),
    );
    await service.submitInboundRecognize(arrival());
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A fresh signature from the same IP is pending (rate limited), never
    // misclassified as the earlier request's bad signature.
    expect(
      await service.submitInboundRecognize(
        arrival('192.0.2.1', 'sig1=:fresh:'),
      ),
    ).toMatchObject({ status: 'pending' });
    expect(verify).toHaveBeenCalledOnce();
    expect(
      await service.submitInboundRecognize(
        arrival('192.0.2.2', 'sig1=:fresh:'),
      ),
    ).toMatchObject({ status: 'pending' });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('reserves one IP slot atomically across concurrent distinct requests', async () => {
    const { service, verify } = subject();
    verify.mockReturnValue(new Promise<void>(() => undefined));
    await Promise.all([
      service.submitInboundRecognize(arrival()),
      service.submitInboundRecognize(
        arrival('::ffff:192.0.2.1', 'sig1=:different:'),
      ),
    ]);
    expect(verify).toHaveBeenCalledOnce();
  });

  it('releases the IP slot after a successful verification so a rotation arrival is verified', async () => {
    const { service, verify } = subject();
    verify.mockResolvedValue(undefined);
    await expect(
      service.submitInboundRecognize(arrival()),
    ).resolves.toMatchObject({ status: 'pending' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    // A root rotation re-recognizes immediately after a completed
    // recognition; the same peer IP must not be cooled down by success.
    await expect(
      service.submitInboundRecognize(arrival('192.0.2.1', 'sig1=:rotated:')),
    ).resolves.toMatchObject({ status: 'pending' });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('does not delay committed recognition because the IP is cooling down', async () => {
    const target = subject();
    await target.service.submitInboundRecognize(arrival());
    target.database.db.query.identityNamespace.findFirst.mockImplementation(
      async (args) =>
        args?.columns?.peerAcceptanceConfirmed
          ? {
              id: 7,
              peerAssignedLocalNamespaceId: 9,
              peerAcceptanceConfirmed: true,
              localServiceAvailable: true,
              trustLevel: 'available',
            }
          : null,
    );
    expect(await target.service.submitInboundRecognize(arrival())).toEqual({
      status: 'recognized',
      peerAssignedLocalNamespaceId: 7,
    });
    expect(target.verify).toHaveBeenCalledOnce();
  });

  it('bounds both FIFO maps and independently sweeps expired one-off entries', async () => {
    vi.useFakeTimers();
    try {
      const { service } = subject();
      const state = service as unknown as {
        inboundRecognizeIps: Map<string, number>;
        inboundRecognizeRefusals: Map<
          string,
          { code: BusinessCode; message: string; expiresAt: number }
        >;
        insertInboundCache: <T>(
          cache: Map<string, T>,
          key: string,
          value: T,
        ) => void;
      };
      for (let i = 0; i <= 4096; i++) {
        state.insertInboundCache(
          state.inboundRecognizeIps,
          String(i),
          Date.now() + 600_000,
        );
        state.insertInboundCache(state.inboundRecognizeRefusals, String(i), {
          code: BusinessCode.FEDERATION_BAD_SIGNATURE,
          message: 'bad',
          expiresAt: Date.now() + 600_000,
        });
      }
      expect(state.inboundRecognizeIps.size).toBe(4096);
      expect(state.inboundRecognizeRefusals.size).toBe(4096);
      expect(state.inboundRecognizeIps.has('0')).toBe(false);
      expect(state.inboundRecognizeRefusals.has('0')).toBe(false);
      expect(state.inboundRecognizeIps.keys().next().value).toBe('1');
      await vi.advanceTimersByTimeAsync(600_000);
      service.cleanupInboundRecognizeCaches();
      expect(state.inboundRecognizeIps.size).toBe(0);
      expect(state.inboundRecognizeRefusals.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores a verifier completion after its run was superseded', async () => {
    const { service, verify } = subject();
    let fail!: (error: unknown) => void;
    verify.mockReturnValue(
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      }),
    );
    await service.submitInboundRecognize(arrival());
    const state = service as unknown as {
      inboundRecognizeInFlight: Map<string, Promise<void>>;
      inboundRecognizeRefusals: Map<string, unknown>;
    };
    const key = state.inboundRecognizeInFlight.keys().next().value!;
    const newer = Promise.resolve();
    state.inboundRecognizeInFlight.set(key, newer);
    fail(
      new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        'obsolete',
        HttpStatus.UNAUTHORIZED,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.inboundRecognizeRefusals.size).toBe(0);
    expect(state.inboundRecognizeInFlight.get(key)).toBe(newer);
  });

  it('does not cache transient failures but keeps the IP verification cooldown', async () => {
    const { service, verify } = subject();
    verify.mockRejectedValue(new Error('well-known fetch timed out'));
    const params = {
      requestIp: '192.0.2.1',
      domain: 'peer.example',
      keyId: 'peer.example/key-1',
      claimedRoot: TEST_ROOT_KEY,
      signedRequest,
      headers: recognizeHeaders,
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
    };

    await expect(service.submitInboundRecognize(params)).resolves.toEqual({
      status: 'pending',
      message: 'verification in progress',
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(service.submitInboundRecognize(params)).resolves.toEqual({
      status: 'pending',
      message: 'verification in progress',
    });
    expect(verify).toHaveBeenCalledOnce();
    await expect(
      service.submitInboundRecognize({ ...params, requestIp: '192.0.2.2' }),
    ).resolves.toMatchObject({ status: 'pending' });
    expect(verify).toHaveBeenCalledTimes(2);
  });

  it('answers a durably halted relationship with the fatal conflict synchronously', async () => {
    const database = {
      db: {
        select: vi.fn(() => selectChain([])),
        query: {
          identityNamespace: {
            findFirst: vi
              .fn()
              .mockResolvedValueOnce(null)
              .mockResolvedValueOnce({
                haltCode: BusinessCode.FEDERATION_PEER_BLOCKED,
              }),
          },
        },
      },
    };
    const service = new FederationRecognitionService(
      database as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const verify = vi
      .spyOn(
        service as unknown as {
          verifyInboundRecognize: (params: unknown) => Promise<void>;
        },
        'verifyInboundRecognize',
      )
      .mockResolvedValue(undefined);

    await expect(
      service.submitInboundRecognize({
        requestIp: '192.0.2.1',
        domain: 'peer.example',
        keyId: 'peer.example/key-1',
        claimedRoot: TEST_ROOT_KEY,
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_PEER_BLOCKED,
      status: 409,
    });
    expect(verify).not.toHaveBeenCalled();
  });
});

describe('FederationRecognitionService Recognize HTTP classification', () => {
  function subject() {
    const service = new FederationRecognitionService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const degraded = vi
      .spyOn(service, 'markTransportDegraded')
      .mockResolvedValue(undefined);
    const halted = vi
      .spyOn(
        service as unknown as Record<string, (...args: unknown[]) => unknown>,
        'markHalted',
      )
      .mockResolvedValue(undefined);
    const handle = (
      service as unknown as {
        handleRecognizeHttpFailure: (
          domain: string,
          response: Response,
        ) => Promise<never>;
      }
    ).handleRecognizeHttpFailure.bind(service);
    return { handle, degraded, halted };
  }

  it('degrades only on the dedicated HTTP 503 availability signal', async () => {
    const { handle, degraded, halted } = subject();

    await expect(
      handle(
        'peer.example',
        Response.json(
          { code: BusinessCode.INTERNAL, message: 'temporarily unavailable' },
          { status: 503 },
        ),
      ),
    ).rejects.toThrow('HTTP 503');

    expect(degraded).toHaveBeenCalledOnce();
    expect(halted).not.toHaveBeenCalled();
  });

  it('does not halt when the fatal code rides a non-closed envelope', async () => {
    const { handle, degraded, halted } = subject();

    await expect(
      handle(
        'peer.example',
        Response.json(
          {
            code: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            message: 'root mismatch',
            forged: true,
          },
          { status: 409 },
        ),
      ),
    ).rejects.toThrow('HTTP 409');

    expect(halted).not.toHaveBeenCalled();
    expect(degraded).not.toHaveBeenCalled();
  });

  it.each([
    BusinessCode.FEDERATION_DOMAIN_CONFLICT,
    BusinessCode.FEDERATION_DOMAIN_CHANGE_REJECTED,
    BusinessCode.FEDERATION_ROOT_CHANGE_REJECTED,
  ])(
    'does not halt for the operation-level code %s even on HTTP 409',
    async (code) => {
      const { handle, degraded, halted } = subject();

      await expect(
        handle(
          'peer.example',
          Response.json(
            { code, message: 'operation refused' },
            { status: 409 },
          ),
        ),
      ).rejects.toThrow('HTTP 409');

      expect(halted).not.toHaveBeenCalled();
      expect(degraded).not.toHaveBeenCalled();
    },
  );

  it('halts only for HTTP 409 paired with a registered fatal code', async () => {
    const { handle, degraded, halted } = subject();

    await expect(
      handle(
        'peer.example',
        Response.json(
          {
            code: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
            message: 'root mismatch',
          },
          { status: 409 },
        ),
      ),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
    });

    expect(halted).toHaveBeenCalledWith(
      'peer.example',
      BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      'root mismatch',
    );
    expect(degraded).not.toHaveBeenCalled();
  });

  it('does not change lifecycle for an HTTP 401 request failure', async () => {
    const { handle, degraded, halted } = subject();

    await expect(
      handle(
        'peer.example',
        Response.json(
          { code: BusinessCode.FEDERATION_BAD_SIGNATURE, message: 'expired' },
          { status: 401 },
        ),
      ),
    ).rejects.toThrow('HTTP 401');

    expect(degraded).not.toHaveBeenCalled();
    expect(halted).not.toHaveBeenCalled();
  });
});
