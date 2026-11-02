import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { build } from 'esbuild';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

const binary = process.env.CADDY_BIN || 'caddy';
const available = spawnSync(binary, ['version']).status === 0;
if (process.env.CI && !available) {
  throw new Error(
    `Caddy routing tests require an executable Caddy binary: ${binary}`,
  );
}

for (const { adminStatus, split } of [
  { adminStatus: 200, split: false },
  { adminStatus: 403, split: false },
  { adminStatus: 200, split: true },
  { adminStatus: 403, split: true },
]) {
  test(
    `generated Caddy routing (admin ${adminStatus}, split domains ${split})`,
    { skip: !available, timeout: 20000 },
    async () => {
      const directory = await mkdtemp(join(tmpdir(), 'soms-caddy-routing-'));
      // Bundle the TS renderer CLI so the test exercises the same code the image runs.
      await build({
        entryPoints: ['scripts/render-caddyfile.ts'],
        outfile: join(directory, 'renderer.cjs'),
        bundle: true,
        platform: 'node',
        format: 'cjs',
      });
      const requests = [];
      const backend = createServer((req, res) => {
        requests.push({ method: req.method, url: req.url });
        res.writeHead(req.url.startsWith('/somfp/v1/') ? 400 : 200, {
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
        const render = spawnSync('node', [join(directory, 'renderer.cjs')], {
          env: {
            PATH: process.env.PATH,
            SOMS_DOMAIN: 'test.local',
            SOMS_WEB_DOMAIN: split ? 'app.test.local' : '',
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
            split
              ? `http://test.local:${edge}, http://*.test.local:${edge}`
              : `http://127.0.0.1:${edge}`,
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
        // Use node:http for explicit logical authorities; browser-style fetch
        // implementations may rewrite Host to the URL's connection hostname.
        const fetch = (target, options = {}) =>
          new Promise((resolve, reject) => {
            const req = request(
              target,
              {
                method: options.method,
                headers: options.headers,
                signal: options.signal,
              },
              (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () =>
                  resolve(
                    new Response(Buffer.concat(chunks), {
                      status: res.statusCode,
                      headers: res.headers,
                    }),
                  ),
                );
                res.on('error', reject);
              },
            );
            req.on('error', reject);
            req.end(options.body);
          });
        const url = `http://127.0.0.1:${edge}`;
        const options = {
          signal: AbortSignal.timeout(2000),
          ...(split ? { headers: { Host: 'app.test.local' } } : {}),
        };
        const federationOptions = split
          ? { ...options, headers: { Host: 'test.local' } }
          : options;
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
        const response = await fetch(`${url}/somfp/v1/recognize`, {
          ...federationOptions,
          method: 'POST',
          body: '{}',
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 50007);
        assert.deepEqual(requests.at(-1), {
          method: 'POST',
          url: '/somfp/v1/recognize',
        });
        for (const path of ['/somfp/discovery', '/api/v1/config']) {
          const r = await fetch(
            url + path,
            path.startsWith('/somfp/') ? federationOptions : options,
          );
          assert.equal(r.status, 200);
          await r.text();
          assert.equal(requests.at(-1).url, path);
        }
        if (split) {
          for (const path of [
            '/client-route',
            '/index.html',
            '/api/v1/config',
            '/uploads/example',
            '/admin/',
          ]) {
            const before = requests.length;
            const denied = await fetch(url + path, federationOptions);
            assert.equal(
              denied.status,
              404,
              `identity host must reject ${path}`,
            );
            await denied.text();
            assert.equal(requests.length, before);
          }
          for (const path of ['/somfp/discovery', '/somfp/v1/health']) {
            const before = requests.length;
            const denied = await fetch(url + path, options);
            assert.equal(
              denied.status,
              404,
              `application host must reject ${path}`,
            );
            await denied.text();
            assert.equal(requests.length, before);
          }
        }
        const spa = await fetch(`${url}/client-route`, options);
        assert.equal(await spa.text(), 'test SPA');
        const adminPath = '/api/v1/admin/diagnostic';
        const adminResponse = await fetch(
          `${url}${adminPath}?token=query-secret-marker`,
          {
            signal: AbortSignal.timeout(2000),
            headers: {
              ...(split ? { Host: 'app.test.local' } : {}),
              Authorization: 'Bearer authorization-secret-marker',
              Cookie: 'session=cookie-secret-marker',
              'X-Diagnostic': 'custom-header-secret-marker',
              'X-Forwarded-For': '192.168.1.42',
            },
          },
        );
        assert.equal(adminResponse.status, adminStatus);
        await adminResponse.text();
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
