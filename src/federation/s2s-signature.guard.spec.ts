import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { S2sSignatureGuard } from './s2s-signature.guard.js';

function subject(overrides?: {
  outboundRecognitionConfirmed?: boolean;
  inboundRecognitionConfirmed?: boolean;
}) {
  const peer = {
    trustLevel: 'available',
    activeNamespaceId: 9,
    recognizesPeer: true,
    outboundRecognitionConfirmed:
      overrides?.outboundRecognitionConfirmed ?? true,
    inboundRecognitionConfirmed: overrides?.inboundRecognitionConfirmed ?? true,
    lightweightInboundReady: true,
    localServiceAvailable: true,
    haltCode: null,
    haltReason: null,
  };
  const verify = {
    extractHeaders: vi.fn().mockReturnValue({}),
    parseSigner: vi.fn().mockReturnValue({
      keyId: 'peer.example/key-1',
      domain: 'peer.example',
      expires: 123,
    }),
    signedRequest: vi.fn().mockReturnValue({}),
    fetchAndVerify: vi.fn().mockResolvedValue(undefined),
  };
  const recognition = {
    markReachable: vi.fn().mockResolvedValue(undefined),
  };
  const guard = new S2sSignatureGuard(
    {
      db: {
        query: {
          federatedPeer: {
            findFirst: vi.fn().mockResolvedValue(peer),
          },
        },
      },
    } as never,
    verify as never,
    { assertAvailable: vi.fn() } as never,
    recognition as never,
  );
  const request = {
    url: '/s2s/v1/accounts/alice',
    body: undefined as unknown,
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  };
  return { guard, context, request, verify, recognition };
}

describe('S2sSignatureGuard recognition and reachability ordering', () => {
  it('admits ordinary data when the peer recognition notification exists', async () => {
    const { guard, context, request, recognition } = subject();

    await expect(guard.canActivate(context as never)).resolves.toBe(true);

    expect(recognition.markReachable).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
    );
    expect(request).toMatchObject({
      peer: {
        domain: 'peer.example',
        namespaceId: 9,
      },
    });
  });

  it('does not require outbound reverse-notification delivery for inbound data', async () => {
    const { guard, context, verify, recognition } = subject({
      outboundRecognitionConfirmed: false,
    });

    await expect(guard.canActivate(context as never)).resolves.toBe(true);

    expect(verify.fetchAndVerify).toHaveBeenCalledOnce();
    expect(recognition.markReachable).toHaveBeenCalledOnce();
  });

  it('refreshes reachability before rejecting a missing peer notification', async () => {
    const { guard, context, verify, recognition } = subject({
      inboundRecognitionConfirmed: false,
    });

    await expect(guard.canActivate(context as never)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
      status: 401,
    });

    expect(verify.fetchAndVerify).toHaveBeenCalledOnce();
    expect(recognition.markReachable).toHaveBeenCalledOnce();
  });

  it('refreshes reachability before a later resource-binding rejection', async () => {
    const { guard, context, request, recognition } = subject();
    request.body = {
      from: { account: 'alice', domain: 'different.example' },
    };

    await expect(guard.canActivate(context as never)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_BINDING_VIOLATION,
      status: 401,
    });

    expect(recognition.markReachable).toHaveBeenCalledOnce();
  });
});
