import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FEDERATION_PEER_HEALTH_RECOVERED } from './federation-health.events.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { S2sRecognitionController } from './s2s-recognition.controller.js';

process.env.SOMS_DOMAIN ??= 'local.example';

describe('S2sRecognitionController Health privacy projection', () => {
  function target() {
    const discovery = {
      fetchWellKnown: vi.fn(),
      getPublicKey: vi.fn().mockRejectedValue(new Error('well-known offline')),
    };
    const verify = {
      extractHeaders: vi.fn().mockReturnValue({}),
      parseSigner: vi.fn().mockReturnValue({
        keyId: 'peer.example/key-2',
        domain: 'peer.example',
      }),
      signedRequest: vi.fn(),
      verifyWithPublicKey: vi.fn(),
    };
    const recognition = {
      hasPreparedPeer: vi.fn().mockResolvedValue(true),
      captureContext: vi.fn().mockResolvedValue({ namespaceId: 12 }),
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

  it('returns unavailable when a recognized peer key cannot be fetched', async () => {
    const { controller, discovery, verify, recognition } = target();

    await expect(
      controller.health({
        url: '/s2s/v1/health',
        rawBody: Buffer.alloc(0),
        headers: {},
      } as never),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(discovery.getPublicKey).toHaveBeenCalledWith(
      'peer.example',
      12,
      'peer.example/key-2',
    );
    expect(verify.verifyWithPublicKey).not.toHaveBeenCalled();
    expect(recognition.queryHealth).not.toHaveBeenCalled();
  });

  it('returns the admission status before refreshing authenticated reachability', async () => {
    const { controller, discovery, recognition } = target();
    discovery.getPublicKey.mockResolvedValue(new Uint8Array(32));
    recognition.queryHealth.mockResolvedValue('degraded');

    await expect(
      controller.health({
        url: '/s2s/v1/health',
        rawBody: Buffer.alloc(0),
        headers: {},
      } as never),
    ).resolves.toEqual({ status: 'degraded' });

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
});

describe('FederationRecognitionService health transitions', () => {
  function service() {
    const events = { emit: vi.fn() };
    const recognition = new FederationRecognitionService(
      {} as never,
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

  it('derives availability independently from recognition direction facts', () => {
    const { recognition } = service();
    const lifecycle = (
      recognition as unknown as {
        lifecycle(peer: Record<string, unknown>): string;
      }
    ).lifecycle.bind(recognition);
    const prepared = {
      trustLevel: 'degraded',
      identityPinnedAt: new Date(),
      recognizesPeer: true,
      localServiceAvailable: true,
      outboundRecognitionConfirmed: false,
      inboundRecognitionConfirmed: false,
    };

    expect(lifecycle({ ...prepared, remoteServiceReachable: false })).toBe(
      'degraded',
    );
    expect(lifecycle({ ...prepared, remoteServiceReachable: true })).toBe(
      'available',
    );
  });

  it('degrades local availability when Health returns unavailable', async () => {
    const service = new FederationRecognitionService(
      {} as never,
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

  function txDatabase() {
    const updateValues = vi.fn();
    const tx = {
      update: vi.fn().mockReturnValue({
        set: vi.fn((values: unknown) => {
          updateValues(values);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      }),
    };
    const database = {
      db: {
        transaction: vi.fn(
          async (operation: (value: typeof tx) => Promise<void>) =>
            operation(tx),
        ),
      },
    };
    return { database, updateValues };
  }

  it.each(['available', 'degraded'] as const)(
    'confirms peer recognition when Health returns %s',
    async (status) => {
      const { database, updateValues } = txDatabase();
      const events = { emit: vi.fn() };
      const recognition = new FederationRecognitionService(
        database as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        events as never,
      );
      vi.spyOn(recognition as never, 'lockPeer').mockResolvedValue({
        trustLevel: 'degraded',
        identityPinnedAt: new Date(),
        recognizesPeer: true,
        localServiceAvailable: true,
        inboundRecognitionConfirmed: false,
        inboundRecognizedAt: null,
        lightweightInboundReady: false,
      });

      await recognition.applyHealthResult('peer.example', status);

      expect(updateValues).toHaveBeenCalledWith(
        expect.objectContaining({
          inboundRecognitionConfirmed: true,
          inboundRecognizedAt: expect.any(Date),
          lightweightInboundReady: true,
          remoteServiceReachable: true,
        }),
      );
      expect(events.emit).toHaveBeenCalledExactlyOnceWith(
        FEDERATION_PEER_HEALTH_RECOVERED,
        { peerDomain: 'peer.example' },
      );
    },
  );

  it('emits no recovery event when the peer was already available', async () => {
    const { database } = txDatabase();
    const events = { emit: vi.fn() };
    const recognition = new FederationRecognitionService(
      database as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      events as never,
    );
    vi.spyOn(
      recognition as unknown as {
        lockPeer(tx: unknown): Promise<Record<string, unknown>>;
      },
      'lockPeer',
    ).mockResolvedValue({
      trustLevel: 'available',
      identityPinnedAt: new Date(),
      recognizesPeer: true,
      localServiceAvailable: true,
      inboundRecognitionConfirmed: true,
      inboundRecognizedAt: new Date(),
      lightweightInboundReady: true,
    });

    await recognition.applyHealthResult('peer.example', 'available');

    expect(events.emit).not.toHaveBeenCalled();
  });

  it('coalesces concurrent Health checks for the same domain', async () => {
    const { recognition } = service();
    let complete!: (status: 'available') => void;
    const pending = new Promise<'available'>((resolve) => {
      complete = resolve;
    });
    const runHealthCheck = vi
      .spyOn(recognition as never, 'runHealthCheck')
      .mockReturnValue(pending);

    const first = recognition.checkHealth('peer.example');
    const second = recognition.checkHealth('peer.example');

    expect(runHealthCheck).toHaveBeenCalledExactlyOnceWith('peer.example');
    complete('available');
    await expect(Promise.all([first, second])).resolves.toEqual([
      'available',
      'available',
    ]);
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
      {} as never,
    );
    const degraded = vi
      .spyOn(service, 'markTransportDegraded')
      .mockResolvedValue(undefined);
    const halted = vi
      .spyOn(service as never, 'markHalted')
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
