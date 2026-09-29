import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import * as tables from '../database/schema.js';
import { FEDERATION_PEER_AVAILABLE } from './federation-peer.events.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { S2sRecognitionController } from './s2s-recognition.controller.js';

process.env.SOMS_DOMAIN ??= 'local.example';

describe('S2sRecognitionController Health privacy projection', () => {
  function target() {
    const discovery = {
      fetchWellKnown: vi.fn(),
      getCachedPublicKey: vi.fn(),
      cacheDocument: vi.fn().mockResolvedValue(undefined),
    };
    const verify = {
      extractHeaders: vi.fn().mockReturnValue({}),
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
        ok: true,
        status: 'pending',
        message: 'verification in progress',
      }),
      queryHealth: vi.fn(),
      markReachable: vi.fn().mockResolvedValue(undefined),
    };
    const controller = new S2sRecognitionController(
      { assertAvailable: vi.fn() } as never,
      verify as never,
      discovery as never,
      recognition as never,
    );
    return { controller, discovery, verify, recognition };
  }

  it('answers a cache miss with the common authentication error and never fetches well-known', async () => {
    const { controller, discovery, verify, recognition } = target();
    discovery.getCachedPublicKey.mockResolvedValue(null);

    await expect(
      controller.health({
        url: '/s2s/v1/health',
        rawBody: Buffer.alloc(0),
        headers: {},
      } as never),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_BAD_SIGNATURE,
      status: 401,
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

  it('maps a signer without a verified identity to the common authentication error', async () => {
    const { controller, discovery, recognition } = target();
    recognition.captureVerifiedContext.mockRejectedValue(
      new Error('no verified namespace'),
    );

    await expect(
      controller.health({
        url: '/s2s/v1/health',
        rawBody: Buffer.alloc(0),
        headers: {},
      } as never),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_BAD_SIGNATURE,
      status: 401,
    });
    expect(discovery.getCachedPublicKey).not.toHaveBeenCalled();
    expect(discovery.fetchWellKnown).not.toHaveBeenCalled();
  });

  it('propagates a failed signature verification as the common authentication error', async () => {
    const { controller, discovery, verify, recognition } = target();
    discovery.getCachedPublicKey.mockResolvedValue(new Uint8Array(32));
    verify.verifyWithPublicKey.mockRejectedValue(
      new BusinessException(
        BusinessCode.FEDERATION_BAD_SIGNATURE,
        'signature verification failed',
        401,
      ),
    );

    await expect(
      controller.health({
        url: '/s2s/v1/health',
        rawBody: Buffer.alloc(0),
        headers: {},
      } as never),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_BAD_SIGNATURE,
      status: 401,
    });
    expect(recognition.queryHealth).not.toHaveBeenCalled();
    expect(recognition.markReachable).not.toHaveBeenCalled();
  });

  it('returns unavailable after authentication when the peer has no prepared receive path', async () => {
    const { controller, discovery, verify, recognition } = target();
    discovery.getCachedPublicKey.mockResolvedValue(new Uint8Array(32));
    recognition.hasPreparedPeer.mockResolvedValue(false);

    await expect(
      controller.health({
        url: '/s2s/v1/health',
        rawBody: Buffer.alloc(0),
        headers: {},
      } as never),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(verify.verifyWithPublicKey).toHaveBeenCalledOnce();
    expect(recognition.queryHealth).not.toHaveBeenCalled();
    expect(recognition.markReachable).not.toHaveBeenCalled();
  });

  it('returns the admission status before refreshing authenticated reachability', async () => {
    const { controller, discovery, recognition } = target();
    discovery.getCachedPublicKey.mockResolvedValue(new Uint8Array(32));
    recognition.queryHealth.mockResolvedValue('degraded');

    await expect(
      controller.health({
        url: '/s2s/v1/health',
        rawBody: Buffer.alloc(0),
        headers: {},
      } as never),
    ).resolves.toEqual({
      status: 'degraded',
      peerAssignedLocalNamespaceId: 12,
    });

    expect(recognition.queryHealth).toHaveBeenCalledBefore(
      recognition.markReachable,
    );
    expect(recognition.markReachable).toHaveBeenCalledWith('peer.example');
    expect(recognition.captureVerifiedContext).toHaveBeenCalledOnce();
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

  it('accepts Recognize into asynchronous verification', async () => {
    const { controller, discovery, recognition } = target();

    await expect(
      controller.recognize({} as never, { namespaceId: 5 }),
    ).resolves.toEqual({
      ok: true,
      status: 'pending',
      message: 'verification in progress',
    });
    expect(discovery.fetchWellKnown).not.toHaveBeenCalled();
    expect(recognition.submitInboundRecognize).toHaveBeenCalledWith({
      domain: 'peer.example',
      keyId: 'peer.example/key-2',
      signedRequest: expect.anything(),
      headers: {},
      namespaceEcho: 5,
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
      recognizesPeer: true,
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
    );
  });

  it('marks reachability lost when Health discovery fails', async () => {
    const recognition = new FederationRecognitionService(
      {} as never,
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
        recognizesPeer: true,
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
      recognizesPeer: true,
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

    expect(insertValues).toHaveBeenCalledWith({
      domain: 'peer.example',
      type: 'available',
      reason: 'Health round trip restored reachability',
    });
    expect(events.emit).toHaveBeenCalledExactlyOnceWith(
      FEDERATION_PEER_AVAILABLE,
      { peerDomain: 'peer.example' },
    );
  });

  it('emits no recovery event when the peer was already available', async () => {
    const { database, insertValues } = txDatabase({
      trustLevel: 'available',
      identityPinnedAt: new Date(),
      recognizesPeer: true,
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
          status: 'available',
          peerAssignedLocalNamespaceId: 44,
        }),
      })),
    };
    const { database } = txDatabase();
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

    expect(discovery.resolveBase).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
    );
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
  function subject(candidate?: Record<string, unknown> | null) {
    const database = {
      db: {
        query: {
          federationNamespaceCandidate: {
            findFirst: vi.fn().mockResolvedValue(candidate ?? null),
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
  };

  it('returns pending when a verified candidate is waiting for administrator approval', async () => {
    const { service, verify } = subject({
      nextDomain: 'peer.example',
      status: 'pending',
    });

    await expect(
      service.submitInboundRecognize({
        domain: 'Peer.Example.',
        keyId: 'peer.example/key-1',
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).resolves.toEqual({
      ok: true,
      status: 'pending',
      message: 'waiting for administrator approval',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('returns failed when a candidate stores a terminal recognition failure', async () => {
    const { service, verify } = subject({
      nextDomain: 'peer.example',
      status: 'failed',
      failedCode: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      failedMessage: 'namespace echo mismatch',
    });

    await expect(
      service.submitInboundRecognize({
        domain: 'peer.example',
        keyId: 'peer.example/key-1',
        signedRequest,
        headers: recognizeHeaders,
        signatureExpires: Math.floor(Date.now() / 1000) + 300,
      }),
    ).resolves.toEqual({
      ok: false,
      status: 'failed',
      code: BusinessCode.FEDERATION_IDENTITY_MISMATCH,
      message: 'namespace echo mismatch',
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it('writes an unmatched root candidate and pending peer after async verification', async () => {
    const candidateValues = vi.fn();
    const candidateConflict = vi.fn();
    const peerValues = vi.fn();
    const peerConflict = vi.fn();
    const eventValues = vi.fn();
    const tx = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
      insert: vi.fn((table: unknown) => {
        if (table === tables.federationNamespaceCandidate) {
          return {
            values: vi.fn((values: unknown) => {
              candidateValues(values);
              return { onConflictDoUpdate: candidateConflict };
            }),
          };
        }
        if (table === tables.federatedPeer) {
          return {
            values: vi.fn((values: unknown) => {
              peerValues(values);
              return { onConflictDoUpdate: peerConflict };
            }),
          };
        }
        return {
          values: vi.fn((values: unknown) => {
            eventValues(values);
            return Promise.resolve();
          }),
        };
      }),
    };
    const database = {
      db: {
        query: {
          federatedPeer: {
            findFirst: vi.fn().mockResolvedValue({ activeNamespaceId: 12 }),
          },
        },
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([
                {
                  rootKeyFingerprint: 'sha256:old',
                  rootPublicKey: Buffer.alloc(32, 1).toString('base64'),
                },
              ]),
            })),
          })),
        })),
        transaction: vi.fn((run: (value: typeof tx) => Promise<void>) =>
          run(tx),
        ),
      },
    };
    const discovery = {
      fetchWellKnown: vi.fn().mockResolvedValue({
        rootKey: { ed25519: Buffer.alloc(32, 2).toString('base64') },
        keys: [
          {
            keyId: 'peer.example/key-1',
            ed25519: Buffer.alloc(32, 3).toString('base64'),
            notBefore: Date.now() - 1000,
            notAfter: Date.now() + 1000,
          },
        ],
      }),
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
    const verify = (
      service as unknown as {
        verifyInboundRecognize: (params: {
          domain: string;
          keyId: string;
          signedRequest: typeof signedRequest;
          headers: typeof recognizeHeaders;
          signatureExpires: number;
          namespaceEcho?: number;
        }) => Promise<void>;
      }
    ).verifyInboundRecognize.bind(service);

    await verify({
      domain: 'Peer.Example.',
      keyId: 'peer.example/key-1',
      signedRequest,
      headers: recognizeHeaders,
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
      namespaceEcho: 44,
    });

    expect(candidateValues).toHaveBeenCalledWith(
      expect.objectContaining({
        nextDomain: 'peer.example',
        matchedNamespaceId: null,
        rootPublicKey: Buffer.alloc(32, 2).toString('base64'),
        peerAssignedLocalNamespaceId: 44,
        status: 'pending',
        failedCode: null,
        failedMessage: null,
      }),
    );
    expect(peerValues).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: 'peer.example',
        trustLevel: 'pending',
        recognizesPeer: true,
        localServiceAvailable: true,
      }),
    );
    expect(eventValues).toHaveBeenCalledWith({
      domain: 'peer.example',
      type: 'pending',
      reason: 'verified namespace candidate with new root',
    });
  });

  it('starts one async verifier per normalized domain and returns pending while it runs', async () => {
    const { service, verify } = subject(null);
    let release!: () => void;
    verify.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const params = {
      domain: 'Peer.Example.',
      keyId: 'peer.example/key-1',
      signedRequest,
      headers: recognizeHeaders,
      signatureExpires: Math.floor(Date.now() / 1000) + 300,
    };

    await expect(service.submitInboundRecognize(params)).resolves.toEqual({
      ok: true,
      status: 'pending',
      message: 'verification in progress',
    });
    await expect(service.submitInboundRecognize(params)).resolves.toEqual({
      ok: true,
      status: 'pending',
      message: 'verification in progress',
    });

    expect(verify).toHaveBeenCalledExactlyOnceWith({
      ...params,
      domain: 'peer.example',
    });
    release();
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
