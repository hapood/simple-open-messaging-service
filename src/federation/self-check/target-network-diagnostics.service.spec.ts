import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  parseDiagnosticTarget,
  TargetNetworkDiagnosticsService,
} from './target-network-diagnostics.service.js';
import type { TransportPolicy } from '../federation-transport.js';
const mocks = vi.hoisted(() => ({
  resolve: vi.fn(),
  create: vi.fn(),
  request: vi.fn(),
  read: vi.fn(),
  destroy: vi.fn(),
}));
vi.mock('../federation-transport.js', () => ({
  resolveFederationRoute: mocks.resolve,
  createFederationDispatcher: mocks.create,
  requestFederation: mocks.request,
  readFederationDiscovery: mocks.read,
}));
const service = () =>
  new TargetNetworkDiagnosticsService({
    get: () => ({ connectTimeoutSec: 12, callTimeoutSec: 15 }),
  } as never);
let policy: TransportPolicy;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolve.mockImplementation(async (domain, options) => {
    const srv = { kind: 'targets', records: [], targets: [] };
    options.observe({ phase: 'srv', evidence: srv });
    return {
      domain,
      baseUrl: `https://${domain}:7668`,
      connectHost: 'edge.example.net',
      srv,
    };
  });
  mocks.destroy.mockResolvedValue(undefined);
  mocks.create.mockImplementation((_route, _timeout, options) => {
    policy = options;
    return { destroy: mocks.destroy };
  });
  mocks.request.mockImplementation(async () => {
    policy.observe?.({
      phase: 'dns',
      host: 'edge.example.net',
      addresses: ['1.1.1.1'],
    });
    policy.validateAddresses?.(['1.1.1.1']);
    policy.observe?.({
      phase: 'tls',
      address: '1.1.1.1',
      port: 7668,
      certificate: null,
    });
    return new Response('{}', {
      headers: { 'content-type': 'application/json' },
    });
  });
  mocks.read.mockResolvedValue({ protocolVersions: [1], roots: [], keys: [] });
});
afterEach(() => vi.useRealTimers());

describe('target diagnostics adapter', () => {
  it.each([
    '',
    'https://example.com',
    'example.com:7668',
    'example.com/path',
    'example.com?q=1',
    'a@b',
    '1.1.1.1',
    '2130706433',
    '0x7f000001',
    '[::1]',
    'a'.repeat(254),
  ])('rejects non-domain input %s', (input) => {
    expect(() => parseDiagnosticTarget(input)).toThrow();
  });
  it('normalizes a bare identity domain', () =>
    expect(parseDiagnosticTarget(' EXAMPLE.COM. ')).toBe('example.com'));
  it('uses only shared transport primitives and their runtime timeouts', async () => {
    const svc = service();
    expect(mocks.resolve).not.toHaveBeenCalled();
    const report = await svc.run('example.com');
    expect(mocks.resolve).toHaveBeenCalledWith(
      'example.com',
      expect.objectContaining({ allowInsecureHttp: false, timeoutMs: 12000 }),
    );
    expect(mocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ connectHost: 'edge.example.net' }),
      12000,
      expect.any(Object),
    );
    expect(mocks.request).toHaveBeenCalledWith(
      'https://example.com:7668/.well-known/somfp',
      expect.any(Object),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        headers: { accept: 'application/json' },
      }),
    );
    expect(mocks.read).toHaveBeenCalledWith(
      'example.com',
      expect.any(Response),
    );
    expect(report.route).toMatchObject({
      host: 'edge.example.net',
      port: 7668,
      domain: 'example.com',
    });
    expect(report.policy).toMatchObject({
      publicDestinationsOnly: true,
      freshConnection: true,
      callTimeoutMs: 15000,
    });
    expect(report.checks.map((c) => [c.name, c.status])).toEqual([
      ['srv', 'ok'],
      ['dns', 'ok'],
      ['https', 'ok'],
      ['federation', 'ok'],
    ]);
    expect(mocks.destroy).toHaveBeenCalledOnce();
    await expect(svc.run('example.com')).rejects.toMatchObject({ status: 429 });
  });
  it('never dials if shared SRV discovery fails', async () => {
    mocks.resolve.mockRejectedValue(new Error('Missing SRV'));
    const report = await service().run('example.com');
    expect(report.route).toBeNull();
    expect(report.checks).toEqual([
      { name: 'srv', status: 'fail', detail: 'Missing SRV' },
    ]);
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it.each([['127.0.0.1'], ['1.1.1.1', '::1'], []])(
    'applies an explicit public-destination restriction: %j',
    async (...addresses) => {
      const ips = addresses.flat() as string[];
      mocks.request.mockImplementation(async () => {
        policy.observe?.({
          phase: 'dns',
          host: 'edge.example.net',
          addresses: ips,
        });
        policy.validateAddresses?.(ips);
        throw new Error('must reject before connection');
      });
      const report = await service().run('example.com');
      expect(report.checks.at(-1)).toMatchObject({
        name: 'dns',
        status: 'fail',
        detail: expect.stringContaining('safety policy'),
      });
      expect(mocks.read).not.toHaveBeenCalled();
      expect(mocks.destroy).toHaveBeenCalledOnce();
    },
  );
  it('reports a real connection failure and disposes the isolated pool', async () => {
    mocks.request.mockImplementation(async () => {
      policy.validateAddresses?.(['1.1.1.1']);
      throw new TypeError('fetch failed', {
        cause: new Error('connect timeout'),
      });
    });
    const report = await service().run('example.com');
    expect(report.checks.at(-1)).toMatchObject({
      name: 'https',
      status: 'fail',
      detail: 'connect timeout',
    });
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
  it('reports the same discovery-document rejection as production', async () => {
    mocks.read.mockRejectedValue(new Error('invalid Content-Type'));
    const report = await service().run('example.com');
    expect(report.checks.at(-1)).toMatchObject({
      name: 'federation',
      status: 'fail',
      detail: 'invalid Content-Type',
    });
    expect(mocks.destroy).toHaveBeenCalledOnce();
  });
});
