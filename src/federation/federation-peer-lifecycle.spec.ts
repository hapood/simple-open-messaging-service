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
        federatedPeer: {
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

describe('FederationPeerLifecycle directional gates', () => {
  it('reports complete recognition independently of degraded reachability', async () => {
    const { lifecycle } = subject({
      trustLevel: 'degraded',
      activeNamespaceId: 7,
      recognizesPeer: true,
      localServiceAvailable: true,
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: true,
    });

    await expect(
      lifecycle.hasCompleteRecognition('peer.example'),
    ).resolves.toBe(true);
  });

  it('does not report complete recognition when either direction is missing', async () => {
    const { lifecycle } = subject({
      trustLevel: 'available',
      activeNamespaceId: 7,
      recognizesPeer: true,
      localServiceAvailable: true,
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: false,
    });

    await expect(
      lifecycle.hasCompleteRecognition('peer.example'),
    ).resolves.toBe(false);
  });

  it('blocks ordinary outbound traffic while a recognized peer is degraded', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'degraded',
      activeNamespaceId: 7,
      recognizesPeer: true,
      localServiceAvailable: true,
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: true,
    });

    await expect(
      lifecycle.checkOutboundReady('peer.example'),
    ).rejects.toBeInstanceOf(FederationTransportError);
    expect(recognition.recognize).not.toHaveBeenCalled();
  });

  it('rejects without starting recognition when the outbound direction is missing', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'available',
      activeNamespaceId: 7,
      recognizesPeer: true,
      localServiceAvailable: true,
      outboundRecognitionConfirmed: false,
      inboundRecognitionConfirmed: true,
    });

    await expect(
      lifecycle.checkOutboundReady('peer.example'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
      status: 401,
    });
    expect(recognition.recognize).not.toHaveBeenCalled();
  });

  it('rejects without starting recognition when the inbound direction is missing', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'available',
      activeNamespaceId: 7,
      recognizesPeer: true,
      localServiceAvailable: true,
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: false,
    });

    await expect(
      lifecycle.checkOutboundReady('peer.example'),
    ).rejects.toMatchObject({
      bizCode: BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
      status: 401,
    });
    expect(recognition.recognize).not.toHaveBeenCalled();
  });

  it('explicitly retries reverse recognition for an available peer', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'available',
      outboundRecognitionConfirmed: false,
      inboundRecognitionConfirmed: true,
      reverseRecognitionPending: true,
    });

    await lifecycle.recoverPeerRecognition('peer.example');

    expect(recognition.recognize).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
    );
  });

  it('retries recognition when only the inbound direction is missing', async () => {
    const { lifecycle, recognition } = subject({
      trustLevel: 'available',
      outboundRecognitionConfirmed: true,
      inboundRecognitionConfirmed: false,
      reverseRecognitionPending: false,
    });

    await lifecycle.recoverPeerRecognition('peer.example');

    expect(recognition.recognize).toHaveBeenCalledExactlyOnceWith(
      'peer.example',
    );
  });
});
