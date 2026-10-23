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
      });
    }
    const state = new DeploymentModeState();
    const publicConfig = state.switch(
      { ...config, adminAccess: 'public' },
      'public',
    );
    assert.equal(
      parse(generateCompose(template, publicConfig)).services.app.network_mode,
      'host',
    );
    const nasConfig = state.switch(publicConfig, 'nas');
    const model = parse(generateCompose(template, nasConfig));
    assert.equal(model.networks, undefined);
    assert.equal(model.services.app.environment.SOMS_ADMIN_ACCESS, 'public');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
