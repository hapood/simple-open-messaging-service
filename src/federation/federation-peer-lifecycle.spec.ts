import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { FederationTransportError } from './federation-errors.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';

process.env.SOMS_DOMAIN ??= 'local.example';

function subject(peer: Record<string, unknown> | undefined) {
  const recognition = {
    recognize: vi.fn().mockResolvedValue(undefined),
  };
  const database = {
    db: {
      query: {
        identityNamespace: {
          findFirst: vi.fn().mockResolvedValue(peer),
        },
      },
    },
  };
  return {
    lifecycle: new FederationPeerLifecycle(
      database as never,
      recognition as never,
      {} as never,
    ),
    recognition,
  };
}

describe('FederationPeerLifecycle recognition and reachability gates', () => {
  it('reports complete recognition independently of degraded reachability', async () => {
    const { lifecycle } = subject({
      trustLevel: 'degraded',
      active: true,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: true,
    });
    await expect(
      lifecycle.hasCompleteRecognition('peer.example'),
    ).resolves.toBe(true);
  });

  it('does not report complete recognition while peer acceptance is unproven', async () => {
    const { lifecycle } = subject({
      trustLevel: 'establishing',
      active: true,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: false,
    });
    await expect(
      lifecycle.hasCompleteRecognition('peer.example'),
    ).resolves.toBe(false);
  });

  it('blocks ordinary outbound traffic while a recognized peer is degraded', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'degraded',
      active: true,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: true,
    });
    await expect(
      lifecycle.checkOutboundReady('peer.example'),
    ).rejects.toBeInstanceOf(FederationTransportError);
    expect(recognition.recognize).not.toHaveBeenCalled();
  });

  it('rejects without starting recognition while peer acceptance is unproven', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'establishing',
      active: true,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: false,
    });
    await expect(
      lifecycle.checkOutboundReady('peer.example'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
      status: 401,
    });
    expect(recognition.recognize).not.toHaveBeenCalled();
  });

  it('allows outbound traffic when acceptance and reachability are proven', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'available',
      active: true,
      localServiceAvailable: true,
      peerAcceptanceConfirmed: true,
    });
    await expect(
      lifecycle.checkOutboundReady('peer.example'),
    ).resolves.toBeUndefined();
    expect(recognition.recognize).not.toHaveBeenCalled();
  });

  it('retries recognition only for an establishing peer', async () => {
    const { lifecycle, recognition } = subject({ trustLevel: 'establishing' });
    await lifecycle.recoverPeerRecognition('peer.example');
    expect(recognition.recognize).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
    );
  });

  it('does not retry recognition for an available peer', async () => {
    const { lifecycle, recognition } = subject({ trustLevel: 'available' });
    await expect(
      lifecycle.recoverPeerRecognition('peer.example'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
      status: 409,
    });
    expect(recognition.recognize).not.toHaveBeenCalled();
  });
});
