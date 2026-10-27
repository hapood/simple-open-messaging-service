import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { S2sSignatureGuard } from './s2s-signature.guard.js';

function subject(overrides?: {
  trustLevel?: string;
  localServiceAvailable?: boolean;
}) {
  const peer = {
    trustLevel: overrides?.trustLevel ?? 'available',
    active: true,
    id: 9,
    domain: 'peer.example',
    rootPublicKey: Buffer.alloc(32, 2).toString('base64'),
    localServiceAvailable: overrides?.localServiceAvailable ?? true,
    haltCode: null,
    haltReason: null,
  };
  const verify = {
    extractHeaders: vi.fn().mockReturnValue({
      's2s-root-key': Buffer.alloc(32, 2).toString('base64'),
    }),
    parseSigner: vi.fn().mockReturnValue({
      keyId: 'peer.example/key-1',
      domain: 'peer.example',
      created: 100,
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
          identityNamespace: {
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
  it('admits ordinary data after local recognition', async () => {
    const { guard, context, request, recognition } = subject();

    await expect(guard.canActivate(context as never)).resolves.toBe(true);

    expect(recognition.markReachable).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
    );
    expect(request).toMatchObject({
      peer: {
        domain: 'peer.example',
        namespaceId: 9,
        signatureCreatedAtSec: 100,
        signatureExpiresAtSec: 123,
      },
    });
  });

  it('does not require peer acceptance for inbound data', async () => {
    const { guard, context, verify, recognition } = subject({
      trustLevel: 'establishing',
    });

    await expect(guard.canActivate(context as never)).resolves.toBe(true);

    expect(verify.fetchAndVerify).toHaveBeenCalledOnce();
    expect(recognition.markReachable).toHaveBeenCalledOnce();
  });

  it('rejects missing local recognition before key fetch', async () => {
    const { guard, context, verify, recognition } = subject({
      localServiceAvailable: false,
    });

    await expect(guard.canActivate(context as never)).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
      status: 401,
    });

    expect(verify.fetchAndVerify).not.toHaveBeenCalled();
    expect(recognition.markReachable).not.toHaveBeenCalled();
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
