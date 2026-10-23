import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';

test('host-network deployment isolates both internal listeners and selects database transport', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soms-database-modes-'));
  try {
    const output = join(dir, 'generator.mjs');
    await build({
      entryPoints: ['web/src/playground/deployment/compose-generator.ts'],
      outfile: output,
      bundle: true,
      platform: 'node',
      format: 'esm',
    });
    const { generateCompose, initialDeployment, deploymentIssues } =
      await import(output);
    const template = await readFile('deploy/nas/docker-compose.yml', 'utf8');
    const config = {
      ...initialDeployment,
      domain: 'example.com',
      dataDir: './data',
      adminPassword: 'test-password',
      dnsToken: 'test-token',
      port: 7668,
    };
    const builtin = parse(generateCompose(template, config));
    assert.equal(builtin.services.app.network_mode, 'host');
    assert.equal(builtin.services.app.ports, undefined);
    assert.equal(
      builtin.services.app.environment.SOMS_BACKEND_SOCKET,
      '/tmp/soms/backend.sock',
    );
    assert.equal(builtin.services.app.environment.SOMS_EDGE_PORT, '7668');
    const publicMode = parse(
      generateCompose(template, { ...config, mode: 'public', port: 7667 }),
    );
    assert.equal(publicMode.services.app.environment.SOMS_EDGE_PORT, 7667);
    assert.equal(publicMode.services.app.network_mode, 'host');
    assert.equal(
      builtin['x-database-environment'].PGHOST,
      '/var/run/postgresql',
    );
    assert.equal(builtin.services.postgres.ports, undefined);
    assert.ok(
      builtin.services.postgres.entrypoint
        .at(-1)
        .includes('local all all scram-sha-256'),
    );
    assert.ok(
      builtin.services.postgres.volumes.some((v) =>
        JSON.stringify(v).includes('postgres-socket'),
      ),
    );
    assert.ok(
      builtin.services.app.volumes.some((v) =>
        JSON.stringify(v).includes('postgres-socket'),
      ),
    );
    assert.ok(
      builtin.services.migrate.volumes.some((v) =>
        JSON.stringify(v).includes('postgres-socket'),
      ),
    );

    const remoteConfig = {
      ...config,
      databaseMode: 'remote',
      remoteHost: 'db.example.com',
      remotePort: 6432,
      remoteCaPath: '/etc/ssl/private/ca.pem',
    };
    assert.deepEqual(deploymentIssues(remoteConfig), []);
    const remote = parse(generateCompose(template, remoteConfig));
    assert.deepEqual(Object.keys(remote.services).sort(), ['app', 'migrate']);
    assert.equal(remote.services.app.network_mode, 'host');
    assert.equal(remote.services.migrate.network_mode, 'host');
    assert.equal(remote['x-database-environment'].PGHOST, 'db.example.com');
    assert.equal(remote['x-database-environment'].PGPORT, '6432');
    for (const service of Object.values(remote.services)) {
      assert.equal(remote['x-database-environment'].SOMS_DB_TLS, 'verify-full');
      assert.equal(
        remote['x-database-environment'].SOMS_DB_CA_FILE,
        '/tmp/soms/db-ca.pem',
      );
      assert.ok(
        service.volumes.some(
          (v) => v.source === '/etc/ssl/private/ca.pem' && v.read_only === true,
        ),
      );
      assert.equal(service.ports, undefined);
    }
    assert.equal(remote.volumes, undefined);
    assert.ok(
      deploymentIssues({ ...remoteConfig, remoteHost: '' }).includes(
        'remoteHost',
      ),
    );
    assert.ok(
      deploymentIssues({ ...remoteConfig, remotePort: 0 }).includes(
        'remotePort',
      ),
    );
    assert.ok(
      deploymentIssues({
        ...remoteConfig,
        remoteCaPath: 'relative.pem',
      }).includes('remoteCaPath'),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
