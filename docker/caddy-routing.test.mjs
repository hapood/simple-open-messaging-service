import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const binary = process.env.CADDY_BIN || 'caddy';
const available = spawnSync(binary, ['version']).status === 0;

for (const adminStatus of [200, 403]) {
  test(
    `generated Caddy routing and sanitized access logs (admin ${adminStatus})`,
    { skip: !available, timeout: 20000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'soms-caddy-routing-'));
      const requests = [];
      const backend = createServer((req, res) => {
        requests.push({ method: req.method, url: req.url });
        res.writeHead(req.url.startsWith('/s2s/') ? 400 : 200, {
          'content-type': 'application/json',
          'set-cookie': 'session=response-secret-marker',
        });
        res.end(
          JSON.stringify({
            code: 50007,
            message: 'test backend signature rejection',
          }),
        );
      });
      let child;
      try {
        backend.listen(0, '127.0.0.1');
        await once(backend, 'listening');
        const upstream = backend.address().port;
        const reserve = createServer();
        reserve.listen(0, '127.0.0.1');
        await once(reserve, 'listening');
        const edge = reserve.address().port;
        await new Promise((resolve) => reserve.close(resolve));
        const render = spawnSync('bash', ['docker/init.sh'], {
          env: {
            PATH: process.env.PATH,
            SOMS_DOMAIN: 'test.local',
            SOMS_TLS_MODE: 'disabled',
            SOMS_ADMIN_ACCESS: 'lan',
            SOMS_RUN_DIR: directory,
          },
          encoding: 'utf8',
        });
        assert.equal(render.status, 0, render.stderr);
        await writeFile(join(directory, 'index.html'), 'test SPA');
        let config = await readFile(join(directory, 'Caddyfile'), 'utf8');
        config = config
          .replaceAll(':7667', `:${edge}`)
          .replaceAll('127.0.0.1:3000', `127.0.0.1:${upstream}`)
          .replaceAll(
            `http://test.local:${edge}, http://*.test.local:${edge}`,
            `http://127.0.0.1:${edge}`,
          )
          .replaceAll('/app/public/web', directory)
          .replaceAll('/app/public/admin', directory);
        if (adminStatus === 403) {
          // Exercise the rejection path using a real loopback peer outside the test allowlist.
          config = config.replace(
            '127.0.0.1 ::1 fc00::/7',
            '192.0.2.1 fc00::/7',
          );
        }
        // Isolate the test server's admin endpoint and configuration storage.
        config = config.replace('{', '{\n admin off');
        await writeFile(join(directory, 'Caddyfile'), config);
        const validate = spawnSync(
          binary,
          [
            'validate',
            '--config',
            join(directory, 'Caddyfile'),
            '--adapter',
            'caddyfile',
          ],
          { encoding: 'utf8' },
        );
        assert.equal(validate.status, 0, validate.stderr);
        child = spawn(
          binary,
          [
            'run',
            '--config',
            join(directory, 'Caddyfile'),
            '--adapter',
            'caddyfile',
          ],
          {
            stdio: ['ignore', 'ignore', 'pipe'],
            env: {
              ...process.env,
              XDG_CONFIG_HOME: directory,
              XDG_DATA_HOME: directory,
            },
          },
        );
        let logs = '';
        child.stderr.on('data', (chunk) => {
          logs += chunk;
        });
        const url = `http://127.0.0.1:${edge}`;
        const options = {
          signal: AbortSignal.timeout(2000),
        };
        let ready = false;
        for (let i = 0; i < 100; i++) {
          try {
            const r = await fetch(url, options);
            await r.text();
            ready = true;
            break;
          } catch {
            if (child.exitCode !== null) break;
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        }
        assert.ok(ready, logs);
        const response = await fetch(`${url}/s2s/v1/recognize`, {
          ...options,
          method: 'POST',
          body: '{}',
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 50007);
        assert.deepEqual(requests.at(-1), {
          method: 'POST',
          url: '/s2s/v1/recognize',
        });
        for (const path of ['/.well-known/somfp', '/api/v1/config']) {
          const r = await fetch(url + path, options);
          assert.equal(r.status, 200);
          await r.text();
          assert.equal(requests.at(-1).url, path);
        }
        const spa = await fetch(`${url}/client-route`, options);
        assert.equal(await spa.text(), 'test SPA');
        const adminPath = '/api/v1/admin/diagnostic';
        const adminResponse = await fetch(
          `${url}${adminPath}?token=query-secret-marker`,
          {
            signal: AbortSignal.timeout(2000),
            headers: {
              Authorization: 'Bearer authorization-secret-marker',
              Cookie: 'session=cookie-secret-marker',
              'X-Diagnostic': 'custom-header-secret-marker',
              'X-Forwarded-For': '192.168.1.42',
            },
          },
        );
        assert.equal(adminResponse.status, adminStatus);
        await adminResponse.text();
        const accessLogs = () =>
          logs.split('\n').flatMap((line) => {
            try {
              const value = JSON.parse(line);
              return value.logger?.startsWith('http.log.access') ? [value] : [];
            } catch {
              return [];
            }
          });
        let entry;
        for (let i = 0; i < 100; i++) {
          entry = accessLogs().find((log) => log.request.uri === adminPath);
          if (entry) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(entry, logs);
        assert.equal(entry.request.remote_ip, '127.0.0.1');
        assert.equal(
          entry.request.client_ip,
          '127.0.0.1',
          'untrusted forwarded headers must not replace the client IP',
        );
        assert.equal(entry.request.method, 'GET');
        assert.equal(entry.request.host, `127.0.0.1:${edge}`);
        assert.equal(entry.status, adminStatus);
        assert.equal(typeof entry.duration, 'number');
        for (const log of accessLogs()) {
          assert.equal(log.request.headers, undefined);
          assert.equal(log.resp_headers, undefined);
        }
        assert.ok(!JSON.stringify(accessLogs()).includes('secret-marker'));
      } finally {
        if (child && child.exitCode === null) {
          const exited = once(child, 'exit');
          child.kill('SIGTERM');
          await exited;
        }
        backend.closeAllConnections();
        await new Promise((resolve) => backend.close(resolve));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
