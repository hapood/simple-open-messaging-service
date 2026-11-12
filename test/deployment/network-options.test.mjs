import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

test('deployment tabs export host networking and admin access settings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soms-network-options-'));
  try {
    const output = join(dir, 'generator.mjs');
    await build({
      entryPoints: ['web/src/playground/deployment/compose-generator.ts'],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
    });
    const {
      generateCompose,
      initialDeployment,
      defaultsForMode,
      DeploymentModeState,
    } = await import(output);
    const template = await readFile('deploy/nas/docker-compose.yml', 'utf8');
    const config = {
      ...initialDeployment,
      domain: 'example.com',
      dataDir: './data',
      adminPassword: 'test-password',
      dnsToken: 'test-token',
    };
    for (const mode of ['public', 'nas']) {
      for (const adminAccess of ['lan', 'public']) {
        const model = parse(
          generateCompose(template, {
            ...config,
            ...defaultsForMode(mode),
            mode,
            adminAccess,
          }),
        );
        assert.equal(model.networks, undefined);
        assert.equal(model.services.app.network_mode, 'host');
        assert.equal(model.services.app.ports, undefined);
        assert.equal(
          model.services.app.environment.SOMS_ADMIN_ACCESS,
          adminAccess,
        );
        assert.equal(
          model.services.app.environment.SOMS_BACKEND_SOCKET,
          '/tmp/soms/backend.sock',
        );
        assert.ok(model.services.postgres);
      }
      assert.deepEqual(defaultsForMode(mode), {
        port: 7667,
        adminAccess: mode === 'public' ? 'public' : 'lan',
        certMode: mode === 'public' ? 'alpn' : 'dns',
      });
    }
    const state = new DeploymentModeState();
    const publicConfig = state.switch(
      { ...config, adminAccess: 'public' },
      'public',
    );
    const publicModel = parse(generateCompose(template, publicConfig));
    assert.equal(publicModel.services.app.network_mode, 'host');
    // ALPN default in public mode: cert mode line replaces the DNS directive, the token
    // line and its anchor disappear, and the ACME email is passed through.
    assert.equal(publicModel.services.app.environment.CADDY_CERT_MODE, 'alpn');
    assert.equal(
      publicModel.services.app.environment.CADDY_DNS_DIRECTIVE,
      undefined,
    );
    assert.equal(
      publicModel.services.app.environment.CLOUDFLARE_API_TOKEN,
      undefined,
    );
    assert.equal(publicModel['x-settings'].dnsToken, undefined);
    const publicEmailModel = parse(
      generateCompose(template, {
        ...publicConfig,
        acmeEmail: 'admin@example.com',
      }),
    );
    assert.equal(
      publicEmailModel.services.app.environment.ACME_EMAIL,
      'admin@example.com',
    );
    const nasConfig = state.switch(publicConfig, 'nas');
    const model = parse(generateCompose(template, nasConfig));
    assert.equal(model.networks, undefined);
    assert.equal(model.services.app.environment.SOMS_ADMIN_ACCESS, 'public');
    // NAS mode locks certMode to dns: the directive is explicit and the token flows via anchor.
    assert.equal(model.services.app.environment.CADDY_CERT_MODE, 'dns');
    assert.equal(
      model.services.app.environment.CADDY_DNS_DIRECTIVE,
      'dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
    );
    assert.equal(
      model.services.app.environment.CLOUDFLARE_API_TOKEN,
      'test-token',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
