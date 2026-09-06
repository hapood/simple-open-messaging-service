import { describe, expect, it, vi } from 'vitest';
import { FederationPeerHttp } from './federation-peer-http.js';

describe('FederationPeerHttp terminal expiry', () => {
  it('preserves the supplied expiry after waiting for a request slot', async () => {
    const release = vi.fn();
    let acquire!: (value: () => void) => void;
    const slot = new Promise<() => void>((resolve) => {
      acquire = resolve;
    });
    const signature = {
      signOutbound: vi.fn().mockResolvedValue({ signature: 'signed' }),
    };
    const discovery = {
      resolveBase: vi.fn().mockResolvedValue('https://peer.example'),
      acquireRequestSlot: vi.fn(() => slot),
      request: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ code: 0 }), { status: 200 }),
        ),
    };
    const lifecycle = {
      markContactSuccess: vi.fn().mockResolvedValue(undefined),
    };
    const http = new FederationPeerHttp(
      signature as never,
      discovery as never,
      {} as never,
      { get: () => ({ callTimeoutSec: 10 }) } as never,
      lifecycle as never,
    );
    const pending = http.post('/s2s/v1/call', '{}', 'peer.example', {
      signatureExpiresAtSec: 1_700_000_300,
    });
    await vi.waitFor(() =>
      expect(discovery.acquireRequestSlot).toHaveBeenCalled(),
    );
    expect(signature.signOutbound).not.toHaveBeenCalled();
    acquire(release);
    await pending;
    expect(signature.signOutbound).toHaveBeenCalledWith(
      {
        method: 'POST',
        url: new URL('https://peer.example/s2s/v1/call'),
        body: '{}',
      },
      expect.any(Date),
      1_700_000_300,
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
