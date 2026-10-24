import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import {
  backendSocketPath,
  listenerProxyTrust,
  prepareBackendSocket,
} from './http-listener.js';

describe('private backend socket', () => {
  it('validates explicit socket paths and forbids TLS on the internal HTTP leg', () => {
    expect(backendSocketPath({})).toBeUndefined();
    expect(
      backendSocketPath({ SOMS_BACKEND_SOCKET: '/tmp/soms/backend.sock' }),
    ).toBe('/tmp/soms/backend.sock');
    expect(() =>
      backendSocketPath({ SOMS_BACKEND_SOCKET: '../relative.sock' }),
    ).toThrow();
    expect(() =>
      backendSocketPath({ SOMS_BACKEND_SOCKET: '/tmp/bad path' }),
    ).toThrow();
    expect(() =>
      backendSocketPath({
        SOMS_BACKEND_SOCKET: '/tmp/test.sock',
        TLS_KEY: '/tmp/key',
      }),
    ).toThrow();
  });

  it('does not remove an active socket and prepares private directories', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'soms-listener-'));
    const socket = join(dir, 'private', 'backend.sock');
    const server = createServer();
    try {
      await prepareBackendSocket(socket);
      expect((await lstat(join(dir, 'private'))).mode & 0o777).toBe(0o700);
      await new Promise<void>((resolve) => server.listen(socket, resolve));
      await expect(prepareBackendSocket(socket)).rejects.toThrow(
        'already exists',
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('trusts only the immediate Unix hop, not forwarded proxy addresses', () => {
    const trustedTcp = (address: string) => address === '127.0.0.1';
    const trust = listenerProxyTrust('/tmp/soms/backend.sock', trustedTcp);
    expect(trust(undefined, 0)).toBe(true);
    expect(trust('172.19.0.1', 1)).toBe(false);
    expect(trust('127.0.0.1', 0)).toBe(false);
    expect(listenerProxyTrust(undefined, trustedTcp)('127.0.0.1', 0)).toBe(
      true,
    );
  });
});
