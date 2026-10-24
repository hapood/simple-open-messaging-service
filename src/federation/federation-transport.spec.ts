import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveSrv } from 'node:dns/promises';
import {
  readFederationDiscovery,
  resolveFederationRoute,
} from './federation-transport.js';
vi.mock('node:dns/promises', () => ({ resolveSrv: vi.fn() }));
afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe('shared federation route resolution', () => {
  it('uses SRV host and port while retaining identity authority', async () => {
    vi.mocked(resolveSrv).mockResolvedValue([
      { name: 'edge.example.net', port: 7668, priority: 0, weight: 0 },
    ]);
    const route = await resolveFederationRoute('PEER.EXAMPLE.', {
      allowInsecureHttp: false,
      timeoutMs: 1000,
    });
    expect(route).toMatchObject({
      domain: 'peer.example',
      baseUrl: 'https://peer.example:7668',
      connectHost: 'edge.example.net',
    });
    expect(resolveSrv).toHaveBeenCalledExactlyOnceWith(
      '_somfp._tcp.peer.example',
    );
  });
  it.each([
    { records: [] },
    { records: [{ name: '.', port: 0, priority: 0, weight: 0 }] },
    { records: [{ name: 'edge.example', port: 0, priority: 0, weight: 0 }] },
  ])('does not fall back for unusable SRV: $records', async ({ records }) => {
    vi.mocked(resolveSrv).mockResolvedValue(records);
    await expect(
      resolveFederationRoute('peer.example', {
        allowInsecureHttp: false,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ name: 'FederationDomainResolutionError' });
  });
  it('bounds a stalled SRV query without publishing a late result', async () => {
    vi.useFakeTimers();
    let finish!: (records: Awaited<ReturnType<typeof resolveSrv>>) => void;
    vi.mocked(resolveSrv).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const observe = vi.fn();
    const pending = resolveFederationRoute('peer.example', {
      allowInsecureHttp: false,
      timeoutMs: 10,
      observe,
    });
    const rejected = expect(pending).rejects.toThrow('SRV deadline exceeded');
    await vi.advanceTimersByTimeAsync(11);
    await rejected;
    finish([{ name: 'late.example', port: 7668, priority: 0, weight: 0 }]);
    await Promise.resolve();
    expect(observe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('uses the explicit insecure development policy without SRV', async () => {
    expect(
      await resolveFederationRoute('peer.example', {
        allowInsecureHttp: true,
        timeoutMs: 1000,
      }),
    ).toEqual({
      domain: 'peer.example',
      baseUrl: 'http://peer.example',
      connectHost: 'peer.example',
      srv: null,
    });
    expect(resolveSrv).not.toHaveBeenCalled();
  });
});

describe('shared discovery response validation', () => {
  it.each([302, 404, 410, 500])(
    'rejects HTTP %s and cancels its body',
    async (status) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), { status });
      await expect(
        readFederationDiscovery('peer.example', response),
      ).rejects.toThrow(`HTTP ${status}`);
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it('rejects the wrong content type and releases the response', async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { 'content-type': 'text/html' },
    });
    await expect(
      readFederationDiscovery('peer.example', response),
    ).rejects.toThrow('invalid Content-Type');
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('enforces the byte cap during streaming and cancels excess data', async () => {
    const cancel = vi.fn();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(256 * 1024 + 1));
        },
        cancel,
      }),
      { headers: { 'content-type': 'application/json' } },
    );
    await expect(
      readFederationDiscovery('peer.example', response),
    ).rejects.toThrow('exceeds 256 KiB');
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });
  it('rejects a malformed or unsigned discovery document', async () => {
    for (const text of ['{', '{}']) {
      const response = new Response(text, {
        headers: { 'content-type': 'application/json' },
      });
      await expect(
        readFederationDiscovery('peer.example', response),
      ).rejects.toThrow();
      expect(response.body?.locked).toBe(false);
    }
  });
});
