import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { createServer, type Server } from 'node:https';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { resolveSrv } from 'node:dns/promises';
import { DiscoveryService } from './discovery.service.js';

const state = vi.hoisted(() => ({
  ca: Buffer.alloc(0),
  lookups: [] as string[],
}));
vi.mock('node:dns/promises', () => ({ resolveSrv: vi.fn() }));
vi.mock('node:dns', async (original) => ({
  ...(await original<typeof import('node:dns')>()),
  lookup: (
    host: string,
    options: { all?: boolean },
    callback: (...args: any[]) => void,
  ) => {
    state.lookups.push(host);
    if (!host.startsWith('target-'))
      return callback(new Error('Apex lookup forbidden'));
    callback(
      null,
      options.all ? [{ address: '127.0.0.1', family: 4 }] : '127.0.0.1',
      4,
    );
  },
}));
// Use real Undici networking and the production dispatcher factory. Only trust
// the ephemeral test certificate; identity verification remains enabled.
vi.mock('undici', async (original) => {
  const actual = await original<typeof import('undici')>();
  return {
    ...actual,
    Agent: class extends actual.Agent {
      constructor(options: any) {
        super({ ...options, connect: { ...options.connect, ca: state.ca } });
      }
    },
  };
});

const services: DiscoveryService[] = [];
const servers: Server[] = [];
let directory: string;
let key: Buffer;
let cert: Buffer;
let port: number;

function service() {
  vi.stubEnv('SOMS_DOMAIN', 'local.example');
  vi.stubEnv('SOMS_ALLOW_INSECURE_HTTP', '0');
  const target = new DiscoveryService(
    {} as never,
    {} as never,
    {} as never,
    {
      get: () => ({ connectTimeoutSec: 2, callTimeoutSec: 2 }),
    } as never,
  );
  services.push(target);
  return target;
}
function srv(p = port, name = 'target-one.example') {
  return [{ name, port: p, priority: 0, weight: 0 }];
}
async function server(label: string) {
  const s = createServer({ key, cert }, (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ label, host: req.headers.host, path: req.url }));
  });
  servers.push(s);
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  return (s.address() as AddressInfo).port;
}
async function request(s: DiscoveryService) {
  const base = await s.resolveBase('peer.example');
  const response = await s.request(`${base}/.well-known/somfp`);
  return response.json();
}

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'soms-route-test-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=peer.example',
      '-addext',
      'subjectAltName=DNS:peer.example',
      '-keyout',
      join(directory, 'key.pem'),
      '-out',
      join(directory, 'cert.pem'),
    ],
    { stdio: 'ignore' },
  );
  key = readFileSync(join(directory, 'key.pem'));
  cert = readFileSync(join(directory, 'cert.pem'));
  state.ca = cert;
  port = await server('first');
});
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.onApplicationShutdown()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(resolveSrv).mockReset();
  state.lookups.length = 0;
});
afterAll(async () => {
  await Promise.all(
    servers.map(
      (s) => new Promise<void>((resolve) => s.close(() => resolve())),
    ),
  );
  rmSync(directory, { recursive: true, force: true });
});

describe('federation route lifecycle with real Undici Agents', () => {
  it('keeps the same pool usable across repeated refreshes without apex DNS', async () => {
    vi.mocked(resolveSrv).mockResolvedValue(srv());
    const s = service();
    for (let i = 0; i < 4; i++) {
      expect(await request(s)).toEqual({
        label: 'first',
        host: `peer.example:${port}`,
        path: '/.well-known/somfp',
      });
      await s.refreshRoute('peer.example');
    }
    expect(state.lookups.length).toBeGreaterThan(0);
    expect(state.lookups.every((host) => host === 'target-one.example')).toBe(
      true,
    );
  });

  it('switches ports and hosts, closing only the replaced pool', async () => {
    vi.mocked(resolveSrv).mockResolvedValue(srv());
    const s = service();
    expect((await request(s)).label).toBe('first');
    const secondPort = await server('second');
    vi.mocked(resolveSrv).mockResolvedValue(
      srv(secondPort, 'target-two.example'),
    );
    await s.refreshRoute('peer.example');
    expect((await request(s)).label).toBe('second');
    await s.refreshRoute('peer.example');
    expect((await request(s)).label).toBe('second');
  });

  it('drains an in-flight response while new requests use the replacement pool', async () => {
    let finish!: () => void;
    const slow = createServer({ key, cert }, (_req, res) => {
      res.writeHead(200);
      res.write('first-');
      finish = () => res.end('last');
    });
    servers.push(slow);
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    vi.mocked(resolveSrv).mockResolvedValue(
      srv((slow.address() as AddressInfo).port),
    );
    const s = service();
    const base = await s.resolveBase('peer.example');
    const response = await s.request(`${base}/stream`);
    const body = response.text();
    vi.mocked(resolveSrv).mockResolvedValue(srv());
    await s.refreshRoute('peer.example');
    expect((await request(s)).label).toBe('first');
    finish();
    expect(await body).toBe('first-last');
    await s.onApplicationShutdown();
  });

  it('bounds shutdown when a response body never finishes', async () => {
    const slow = createServer({ key, cert }, (_req, res) => {
      res.writeHead(200);
      res.write('never ends');
    });
    servers.push(slow);
    await new Promise<void>((resolve) => slow.listen(0, '127.0.0.1', resolve));
    vi.mocked(resolveSrv).mockResolvedValue(
      srv((slow.address() as AddressInfo).port),
    );
    const s = service();
    const base = await s.resolveBase('peer.example');
    const response = await s.request(`${base}/stream`);
    const body = expect(response.text()).rejects.toThrow();
    await s.onApplicationShutdown();
    await body;
  });

  it('coalesces simultaneous discoveries and refreshes', async () => {
    vi.mocked(resolveSrv).mockResolvedValue(srv());
    const s = service();
    await Promise.all([
      s.resolveBase('peer.example'),
      s.refreshRoute('peer.example'),
      s.resolveBase('peer.example'),
    ]);
    expect(resolveSrv).toHaveBeenCalledTimes(1);
    expect((await request(s)).label).toBe('first');
  });

  it('rejects stale DNS results after invalidation without overwriting a newer route', async () => {
    let finish!: (records: ReturnType<typeof srv>) => void;
    vi.mocked(resolveSrv).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const s = service();
    const pending = s.resolveBase('peer.example');
    const rejected = expect(pending).rejects.toThrow('invalidated');
    await Promise.resolve();
    s.invalidateBase('peer.example');
    vi.mocked(resolveSrv).mockResolvedValue(srv());
    expect((await request(s)).label).toBe('first');
    finish(srv(1, 'target-obsolete.example'));
    await rejected;
    expect((await request(s)).label).toBe('first');
  });

  it('keeps a working route on DNS refresh failure', async () => {
    vi.mocked(resolveSrv).mockResolvedValue(srv());
    const s = service();
    await request(s);
    vi.mocked(resolveSrv).mockRejectedValue(new Error('DNS unavailable'));
    await s.refreshRoute('peer.example');
    expect((await request(s)).label).toBe('first');
  });

  it('does not resurrect routes after shutdown', async () => {
    let finish!: (records: ReturnType<typeof srv>) => void;
    vi.mocked(resolveSrv).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const s = service();
    const pending = s.resolveBase('peer.example');
    const rejected = expect(pending).rejects.toThrow('shutting down');
    await Promise.resolve();
    await s.onApplicationShutdown();
    finish(srv());
    await rejected;
    await expect(s.resolveBase('peer.example')).rejects.toThrow(
      'shutting down',
    );
  });

  it('rejects an obsolete URL instead of silently connecting to its old port', async () => {
    vi.mocked(resolveSrv).mockResolvedValue(srv());
    const s = service();
    const base = await s.resolveBase('peer.example');
    vi.mocked(resolveSrv).mockResolvedValue(srv(await server('new-port')));
    await s.refreshRoute('peer.example');
    await expect(s.request(`${base}/test`)).rejects.toThrow('route changed');
    expect((await request(s)).label).toBe('new-port');
  });
});
