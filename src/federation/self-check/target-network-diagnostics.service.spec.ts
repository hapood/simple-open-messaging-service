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
  cname: vi.fn(),
  v4: vi.fn(),
  v6: vi.fn(),
}));
vi.mock('../federation-transport.js', () => ({
  resolveFederationRoute: mocks.resolve,
  createFederationDispatcher: mocks.create,
  requestFederation: mocks.request,
  readFederationDiscovery: mocks.read,
}));
vi.mock('node:dns/promises', () => ({
  resolveCname: mocks.cname,
  resolve4: mocks.v4,
  resolve6: mocks.v6,
}));
const noRecord = (code: string) => Object.assign(new Error(code), { code });
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
  mocks.cname.mockRejectedValue(noRecord('ENODATA'));
  mocks.v4.mockResolvedValue(['1.1.1.1']);
  mocks.v6.mockRejectedValue(noRecord('ENODATA'));
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
      origin: 'https://example.com:7668',
    });
    expect(report.policy).toMatchObject({
      freshConnection: true,
      callTimeoutMs: 15000,
    });
    expect(report.policy).not.toHaveProperty('publicDestinationsOnly');
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
    expect(mocks.v4).not.toHaveBeenCalled();
  });
  it.each([
    ['192.168.108.7', 'private'],
    ['198.18.0.101', 'reserved'],
    ['2605:52c0:2:28ad:44c:2dff:feaf:5011', 'unicast'],
  ])(
    'dials whatever the resolver returned and labels its scope: %s',
    async (address, scope) => {
      mocks.request.mockImplementation(async () => {
        policy.observe?.({
          phase: 'dns',
          host: 'edge.example.net',
          addresses: [address],
        });
        policy.observe?.({
          phase: 'tls',
          address,
          port: 7668,
          certificate: null,
        });
        return new Response('{}', {
          headers: { 'content-type': 'application/json' },
        });
      });
      const report = await service().run('example.com');
      const dns = report.checks.find((check) => check.name === 'dns');
      expect(dns).toMatchObject({
        status: 'ok',
        detail: expect.stringContaining(`${address} (${scope})`),
      });
      expect(dns?.evidence?.dial).toEqual([
        { address, family: address.includes(':') ? 6 : 4, scope },
      ]);
      expect(mocks.read).toHaveBeenCalled();
      expect(mocks.destroy).toHaveBeenCalledOnce();
    },
  );
  it('reports an empty resolver answer as a dial failure without inventing evidence', async () => {
    mocks.request.mockImplementation(async () => {
      policy.observe?.({
        phase: 'dns',
        host: 'edge.example.net',
        addresses: [],
      });
      throw new TypeError('fetch failed', {
        cause: new Error('Destination has no IP addresses'),
      });
    });
    const report = await service().run('example.com');
    expect(report.checks.filter((check) => check.name === 'dns')).toEqual([
      {
        name: 'dns',
        status: 'fail',
        detail: 'Destination has no IP addresses',
      },
    ]);
  });
  it('shows the walked CNAME chain and warns about the RFC 2782 SRV-target rule', async () => {
    mocks.cname
      .mockResolvedValueOnce(['relay.example.net'])
      .mockRejectedValueOnce(noRecord('ENODATA'));
    mocks.v4.mockResolvedValue(['203.0.113.9']);
    const report = await service().run('example.com');
    const dns = report.checks.find((check) => check.name === 'dns');
    expect(dns?.status).toBe('warn');
    expect(dns?.detail).toContain(
      'edge.example.net -> relay.example.net (RFC 2782',
    );
    expect(dns?.evidence?.resolved).toEqual({
      host: 'relay.example.net',
      v4: ['203.0.113.9'],
      v6: [],
      cnameChain: [
        { name: 'edge.example.net', targets: ['relay.example.net'] },
      ],
      errors: { v6: 'ENODATA' },
    });
  });
  it('surfaces raw resolver failure codes beside the dial result', async () => {
    mocks.v4.mockRejectedValue(
      Object.assign(new Error('server failure'), { code: 'ESERVFAIL' }),
    );
    const report = await service().run('example.com');
    const dns = report.checks.find((check) => check.name === 'dns');
    expect(dns?.status).toBe('ok');
    expect(dns?.evidence?.resolved.errors).toEqual({
      v4: 'ESERVFAIL',
      v6: 'ENODATA',
    });
    expect(dns?.evidence?.dial).toEqual([
      { address: '1.1.1.1', family: 4, scope: 'unicast' },
    ]);
    expect(report.checks.at(-1)).toMatchObject({
      name: 'federation',
      status: 'ok',
    });
  });
  it('reports a real connection failure and disposes the isolated pool', async () => {
    mocks.request.mockImplementation(async () => {
      policy.observe?.({
        phase: 'dns',
        host: 'edge.example.net',
        addresses: ['1.1.1.1'],
      });
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
