import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createRun } from './acceptance-run.mjs';

// Exercise the real driver transport without launching a browser or contacting a deployment.
describe('configured driver protocol', () => {
  it('reads per-node secrets from the private pipe and performs bounded preflight', async () => {
    const password = 'private-protocol-fixture';
    let redirectOutside = false;
    const servers = [0, 1].map(() =>
      createServer((req, res) => {
        if (req.url === '/admin/') {
          res.writeHead(302, {
            Location: redirectOutside
              ? 'https://unapproved.invalid/login'
              : '/admin/login',
          });
          res.end();
        } else if (req.url === '/api/v1/client/compat') {
          res.setHeader('Content-Type', 'application/json');
          res.end(
            JSON.stringify({
              code: 0,
              data: { serverVersion: password, apiVersion: 1 },
            }),
          );
        } else res.end('<html><body>fixture</body></html>');
      }),
    );
    const root = mkdtempSync(join(tmpdir(), 'soms-driver-protocol-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const origins: string[] = [];
      for (const server of servers) {
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const address = server.address();
        if (!address || typeof address === 'string')
          throw new Error('Missing fixture server address.');
        origins.push(`http://127.0.0.1:${address.port}/`);
      }
      const nodes = Object.fromEntries(
        ['alpha', 'bravo'].map((key, index) => [
          key,
          {
            edge: origins[index],
            admin: `${origins[index]}admin/`,
            service: origins[index],
            domain: `${key}.test`,
            account: 'admin',
          },
        ]),
      );
      const run = createRun(root, 'quick', nodes);
      child = spawn(
        process.execPath,
        [resolve('test/browser-e2e/driver.mjs')],
        {
          env: {
            ...process.env,
            BROWSER_DEPLOYMENT_FILE: join(run.directory, 'run.json'),
            BROWSER_ARTIFACT_DIR: run.directory,
          },
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        },
      );
      const waiting = new Map<number, (value: any) => void>();
      const received = new Map<number, any>();
      let output = '';
      let stderr = '';
      child.stderr!.on('data', (chunk) => {
        stderr += chunk;
      });
      const reader = createInterface({ input: child.stdout! });
      reader.on('line', (line) => {
        output += line;
        const value = JSON.parse(line);
        const callback = waiting.get(value.id);
        if (callback) {
          waiting.delete(value.id);
          callback(value);
        } else received.set(value.id, value);
      });
      const reply = (id: number) =>
        received.has(id)
          ? Promise.resolve(received.get(id))
          : new Promise<any>((done) => {
              waiting.set(id, done);
            });
      const pipe = child.stdio[3] as import('node:stream').Writable;
      pipe.end(
        JSON.stringify({ alpha: password, bravo: 'other-private-fixture' }),
      );
      expect((await reply(0)).ok).toBe(true);
      child.stdin!.write(JSON.stringify({ id: 1, action: 'status' }) + '\n');
      const status = await reply(1);
      expect(Object.keys(status.data.nodes)).toEqual(['alpha', 'bravo']);
      expect(status.data.nodes.alpha.domain).toBe('alpha.test');
      child.stdin!.write(JSON.stringify({ id: 2, action: 'preflight' }) + '\n');
      const health = await reply(2);
      expect(health.ok).toBe(true);
      expect(health.data.alpha.edgeCompat.serverVersion).toBe('[REDACTED]');
      child.stdin!.write(
        JSON.stringify({
          id: 3,
          action: 'userLogin',
          node: 'charlie',
          user: 'invalid',
          account: 'same',
        }) + '\n',
      );
      expect((await reply(3)).ok).toBe(false);
      redirectOutside = true;
      child.stdin!.write(JSON.stringify({ id: 4, action: 'preflight' }) + '\n');
      const rejectedRedirect = await reply(4);
      expect(rejectedRedirect.ok).toBe(false);
      expect(rejectedRedirect.error).toContain('outside approved origins');
      expect(output + stderr).not.toContain(password);
      expect(output + stderr).not.toContain('other-private-fixture');
    } finally {
      if (child && child.exitCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
      for (const server of servers) {
        server.closeAllConnections();
        server.close();
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
