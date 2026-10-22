import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

test('NAS UI generator preserves canonical services and safely escapes Compose values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'soms-generator-'));
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
      composeScalar,
      deploymentIssues,
    } = await import(output);
    const template = await readFile('deploy/nas/docker-compose.yml', 'utf8');
    const { version } = JSON.parse(await readFile('package.json', 'utf8'));
    const releaseImage = `ghcr.io/hapood/simple-open-messaging-service:v${version}`;
    assert.equal(initialDeployment.image, releaseImage);
    for (const [path, expectedImage] of [
      ['deploy/nas/docker-compose.yml', releaseImage],
      [
        'deploy/public/docker-compose.yml',
        'ghcr.io/hapood/simple-open-messaging-service:latest',
      ],
    ]) {
      const source = await readFile(path, 'utf8');
      const images = [...source.matchAll(/^    image: (.+)$/gm)]
        .map((match) => match[1])
        .filter((image) => !image.startsWith('postgres:'));
      assert.deepEqual(images, [expectedImage, expectedImage], path);
    }
    assert.equal(composeScalar('a$b'), '"a$$b"');
    const config = {
      ...initialDeployment,
      domain: 'example.com',
      webDomain: 'soms.example.com',
      port: 7668,
      databasePassword: 'password$with"quotes\nand more',
      adminPassword: 'admin-password-long',
      dnsToken: 'dummy-token',
    };
    assert.deepEqual(deploymentIssues(config), []);
    assert.ok(deploymentIssues({ ...config, port: 0 }).length);
    assert.ok(
      deploymentIssues({ ...config, domain: 'https://example.com' }).length,
    );
    const yaml = generateCompose(template, config);
    assert.ok(!/LOG_LEVEL|log_level|log-level/.test(yaml));
    assert.ok(!('logLevel' in initialDeployment));
    assert.ok(yaml.includes('dummy-token'));
    assert.ok(yaml.includes(config.adminPassword));
    assert.ok(yaml.includes(composeScalar(config.databasePassword)));
    assert.ok(!yaml.includes('<hidden>'));
    assert.ok(yaml.indexOf('database_password:') < yaml.indexOf('services:'));
    assert.ok(yaml.includes('published: *published-port'));
    assert.throws(() =>
      generateCompose(template.replace('PGPASSWORD:', 'CHANGED:'), config),
    );
    const file = join(dir, 'compose.yaml');
    await writeFile(file, yaml);
    // host-spawn is used only when the local Docker CLI is unavailable (Distrobox).
    const local = spawnSync('docker', ['compose', 'version']);
    const args = ['compose', '-f', file, 'config', '--format', 'json'];
    const parse = () =>
      local.status === 0
        ? spawnSync('docker', args, { encoding: 'utf8' })
        : spawnSync('host-spawn', ['-no-pty', 'docker', ...args], {
            encoding: 'utf8',
          });
    const result = parse();
    assert.equal(result.status, 0, result.stderr || 'Docker Compose required');
    const model = JSON.parse(result.stdout);
    assert.equal(model.services.app.image, releaseImage);
    assert.equal(model.services.migrate.image, releaseImage);
    // Compose config emits a re-loadable model, preserving dollar escapes.
    const escaped = config.databasePassword.replaceAll('$', () => '$$');
    assert.equal(model.services.app.environment.PGPASSWORD, escaped);
    assert.equal(
      model.services.postgres.environment.POSTGRES_PASSWORD,
      escaped,
    );
    assert.equal(model.services.migrate.environment.PGPASSWORD, escaped);
    assert.equal(model.services.app.ports[0].published, '7668');
    assert.equal(
      model.services.app.environment.SOMS_WEBAUTHN_ALLOWED_ORIGINS,
      'https://soms.example.com:7668',
    );
    await writeFile(
      file,
      generateCompose(template, {
        ...config,
        ...defaultsForMode('public'),
        mode: 'public',
      }),
    );
    const publicResult = parse();
    assert.equal(publicResult.status, 0, publicResult.stderr);
    const publicModel = JSON.parse(publicResult.stdout);
    assert.equal(publicModel.services.app.image, releaseImage);
    assert.equal(publicModel.services.migrate.image, releaseImage);
    assert.equal(
      publicModel.services.app.environment.SOMS_TLS_MODE,
      'standard',
    );
    assert.equal(
      publicModel.services.app.environment.SOMS_WEBAUTHN_ALLOWED_ORIGINS,
      'https://soms.example.com',
    );
    assert.deepEqual(
      publicModel.services.app.ports.map((p) => p.published),
      ['80', '443', '443'],
    );
    await writeFile(
      file,
      generateCompose(template, {
        ...config,
        ...defaultsForMode('public'),
        mode: 'public',
        dnsToken: '',
      }),
    );
    const noRedirect = parse();
    assert.equal(noRedirect.status, 0, noRedirect.stderr);
    assert.deepEqual(
      JSON.parse(noRedirect.stdout).services.app.ports.map((p) => p.published),
      ['80', '443', '443'],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
