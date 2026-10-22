import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';

function makeSubject() {
  const peerHttp = { get: vi.fn() };
  const peerLifecycle = {
    checkOutboundReady: vi.fn().mockResolvedValue(undefined),
  };
  return {
    subject: new FederationTrustedPeerClient(
      peerHttp as never,
      peerLifecycle as never,
    ),
    peerHttp,
    peerLifecycle,
  };
}

describe('FederationTrustedPeerClient', () => {
  it('checks trust before running an operation', async () => {
    const { subject, peerLifecycle } = makeSubject();
    const operation = vi.fn().mockResolvedValue('ok');

    await expect(subject.run('peer.example', operation)).resolves.toBe('ok');
    expect(peerLifecycle.checkOutboundReady).toHaveBeenCalledWith(
      'peer.example',
    );
    expect(operation).toHaveBeenCalledOnce();
  });

  it('does not run the operation when the directional check fails', async () => {
    const { subject, peerLifecycle } = makeSubject();
    const error = new Error('outbound recognition is incomplete');
    peerLifecycle.checkOutboundReady.mockRejectedValue(error);
    const operation = vi.fn();

    await expect(subject.run('peer.example', operation)).rejects.toBe(error);
    expect(operation).not.toHaveBeenCalled();
  });

  it('does not recover or retry a recognition-required peer response', async () => {
    const { subject } = makeSubject();
    const error = new S2sResponseError(
      'recognition required',
      401,
      BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
    );
    const operation = vi.fn().mockRejectedValue(error);

    await expect(subject.run('peer.example', operation)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledOnce();
  });
});
