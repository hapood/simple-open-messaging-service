import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { TargetNetworkDiagnosticsService } from './target-network-diagnostics.service.js';
import { DiscoveryService } from '../discovery.service.js';
import {
  createFederationDispatcher,
  requestFederation,
} from '../federation-transport.js';

const state = vi.hoisted(() => ({
  ca: Buffer.alloc(0) as Buffer,
  port: 0,
  queries: [] as string[],
  requests: [] as {
    host: string | undefined;
    sni: string;
    path: string | undefined;
  }[],
}));
vi.mock('node:dns/promises', () => ({
  resolveSrv: async (name: string) => {
    state.queries.push(name);
    return [
      { name: 'edge.example.net', port: state.port, priority: 0, weight: 0 },
    ];
  },
}));
// Allow the loopback fixture only in this test. Production rejects private destinations.
vi.mock('./network-inspection.service.js', () => ({
  isPublicAddress: () => true,
}));
vi.mock('node:dns', async (original) => ({
  ...(await original<typeof import('node:dns')>()),
  lookup: (
    name: string,
    _options: unknown,
    callback: (
      error: Error | null,
      addresses?: { address: string; family: number }[],
    ) => void,
  ) => {
    state.queries.push(name);
    queueMicrotask(() =>
      name === 'edge.example.net'
        ? callback(null, [{ address: '127.0.0.1', family: 4 }])
        : callback(new Error('Unexpected apex lookup')),
    );
  },
}));
vi.mock('undici', async (original) => {
  const actual = await original<typeof import('undici')>();
  return {
    ...actual,
    buildConnector: (options: object) =>
      actual.buildConnector({ ...options, ca: state.ca }),
  };
});
const service = () =>
  new TargetNetworkDiagnosticsService({
    get: () => ({ connectTimeoutSec: 2, callTimeoutSec: 2 }),
  } as never);

let directory: string;
let server: Server;
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'soms-diagnostic-tls-'));
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
  state.ca = readFileSync(join(directory, 'cert.pem'));
  server = createServer(
    { key: readFileSync(join(directory, 'key.pem')), cert: state.ca },
    (req, res) => {
      state.requests.push({
        host: req.headers.host,
        sni: (req.socket as TLSSocket & { servername: string }).servername,
        path: req.url,
      });
      res.writeHead(404);
      res.end();
    },
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (directory) rmSync(directory, { recursive: true, force: true });
});

describe('diagnostic SRV routing with real TLS', () => {
  it('connects to the SRV endpoint with the identity domain as Host and SNI', async () => {
    const report = await service().run('peer.example');
    expect(report.route).toMatchObject({
      host: 'edge.example.net',
      port: state.port,
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({ name: 'https', status: 'ok' }),
    );
    expect(state.requests).toContainEqual({
      host: `peer.example:${state.port}`,
      sni: 'peer.example',
      path: '/.well-known/somfp',
    });
    expect(state.queries).toContain('_somfp._tcp.peer.example');
    expect(state.queries).toContain('edge.example.net');
    expect(state.queries).not.toContain('peer.example');
    // Exercise the business caller against the exact same server and connector.
    vi.stubEnv('SOMS_DOMAIN', 'local.example');
    vi.stubEnv('SOMS_ALLOW_INSECURE_HTTP', '0');
    const discovery = new DiscoveryService(
      {} as never,
      {} as never,
      {} as never,
      { get: () => ({ connectTimeoutSec: 2, callTimeoutSec: 2 }) } as never,
    );
    try {
      const base = await discovery.resolveBase('peer.example');
      const response = await discovery.request(`${base}/.well-known/somfp`);
      await response.text();
      expect(response.status).toBe(404);
      expect(state.requests.at(-1)).toEqual(state.requests.at(-2));
    } finally {
      await discovery.onApplicationShutdown();
      vi.unstubAllEnvs();
    }
  });
  it('enforces the caller address restriction before the shared connector opens a socket', async () => {
    const count = state.requests.length;
    const dispatcher = createFederationDispatcher(
      { domain: 'peer.example', connectHost: 'edge.example.net' },
      2000,
      {
        validateAddresses: (addresses) => {
          expect(addresses).toEqual(['127.0.0.1']);
          throw new Error('destination denied');
        },
      },
    );
    try {
      await expect(
        requestFederation(
          `https://peer.example:${state.port}/.well-known/somfp`,
          dispatcher,
        ),
      ).rejects.toMatchObject({
        cause: expect.objectContaining({ message: 'destination denied' }),
      });
      expect(state.requests).toHaveLength(count);
    } finally {
      await dispatcher.destroy();
    }
  });
  it('rejects a certificate for a different identity even when the SRV endpoint connects', async () => {
    const count = state.requests.length;
    const report = await service().run('wrong.example');
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        name: 'https',
        status: 'fail',
        detail: expect.stringMatching(/does not match/),
      }),
    );
    expect(state.requests).toHaveLength(count);
  });
});
