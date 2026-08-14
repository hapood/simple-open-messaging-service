import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationRecognitionService } from './federation-recognition.service.js';
import { S2sRecognitionController } from './s2s-recognition.controller.js';

process.env.SOMS_DOMAIN ??= 'local.example';

describe('S2sRecognitionController Healthy privacy projection', () => {
  it('returns unavailable when a recognized peer key cannot be fetched', async () => {
    const discovery = {
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
      hasPinnedIdentity: vi.fn().mockResolvedValue(true),
      queryHealth: vi.fn(),
    };
    const controller = new S2sRecognitionController(
      { assertAvailable: vi.fn() } as never,
      verify as never,
      discovery as never,
      recognition as never,
    );

    await expect(
      controller.healthy({} as never, { domain: 'peer.example' }),
    ).resolves.toEqual({ status: 'unavailable' });
    expect(discovery.getPublicKey).toHaveBeenCalledWith(
      'peer.example',
      'peer.example/key-2',
    );
    expect(verify.verifyWithPublicKey).not.toHaveBeenCalled();
    expect(recognition.queryHealth).not.toHaveBeenCalled();
  });
});

describe('FederationRecognitionService health transitions', () => {
  it('replays the latest recognition stage to re-entrant subscribers', () => {
    const service = new FederationRecognitionService(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribeFirst = service.subscribeProgress('peer.example', first);
    (
      service as unknown as {
        publishProgress(domain: string, stage: 'WAITING_FOR_PEER'): void;
      }
    ).publishProgress('peer.example', 'WAITING_FOR_PEER');

    const unsubscribeSecond = service.subscribeProgress('peer.example', second);

    expect(first).toHaveBeenLastCalledWith('WAITING_FOR_PEER');
    expect(second).toHaveBeenCalledExactlyOnceWith('WAITING_FOR_PEER');
    unsubscribeFirst();
    unsubscribeSecond();
  });

  it('degrades local availability when Healthy returns unavailable', async () => {
    const service = new FederationRecognitionService(
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
      'Healthy unavailable',
    );
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
