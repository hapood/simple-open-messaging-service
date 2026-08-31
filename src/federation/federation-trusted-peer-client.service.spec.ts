import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';

function makeSubject() {
  const peerHttp = { get: vi.fn() };
  const peerLifecycle = {
    ensureTrusted: vi.fn().mockResolvedValue(undefined),
    recoverTrust: vi.fn().mockResolvedValue(undefined),
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
    expect(peerLifecycle.ensureTrusted).toHaveBeenCalledWith('peer.example');
    expect(operation).toHaveBeenCalledOnce();
  });

  it('recovers recognition and retries that specific peer response once', async () => {
    const { subject, peerLifecycle } = makeSubject();
    const operation = vi
      .fn()
      .mockRejectedValueOnce(
        new S2sResponseError(
          'recognition required',
          409,
          BusinessCode.FEDERATION_RECOGNITION_REQUIRED,
        ),
      )
      .mockResolvedValueOnce('recovered');

    await expect(subject.run('peer.example', operation)).resolves.toBe(
      'recovered',
    );
    expect(peerLifecycle.recoverTrust).toHaveBeenCalledWith('peer.example');
    expect(operation).toHaveBeenCalledTimes(2);
  });

  it('does not retry unrelated peer failures', async () => {
    const { subject, peerLifecycle } = makeSubject();
    const error = new S2sResponseError(
      'group dissolved',
      200,
      BusinessCode.GROUP_DISSOLVED,
    );
    const operation = vi.fn().mockRejectedValue(error);

    await expect(subject.run('peer.example', operation)).rejects.toBe(error);
    expect(peerLifecycle.recoverTrust).not.toHaveBeenCalled();
    expect(operation).toHaveBeenCalledOnce();
  });
});
