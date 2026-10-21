import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const template = readFileSync(
  new URL('../deploy/nas/docker-compose.yml', import.meta.url),
  'utf8',
);
const compose = [
  ['docker', ['compose']],
  ['host-spawn', ['docker', 'compose']],
].find(([command, args]) => {
  const result = spawnSync(command, [...args, 'version'], {
    encoding: 'utf8',
  });
  return result.status === 0;
});
const options = {
  skip: compose ? false : 'Docker Compose v2+ is required (no daemon needed)',
};

function resolveConfig(source = template) {
  const directory = mkdtempSync(join(tmpdir(), 'soms-nas-compose-'));
  try {
    const path = join(directory, 'docker-compose.yml');
    writeFileSync(path, source, { mode: 0o600 });
    // No .env exists in this isolated deployment. Host values must not override the YAML.
    const [command, args] = compose;
    const result = spawnSync(
      command,
      [
        ...args,
        '--env-file',
        '/dev/null',
        '--project-directory',
        directory,
        '-f',
        path,
        'config',
        '--format',
        'json',
      ],
      {
        cwd: directory,
        encoding: 'utf8',
        env: {
          ...process.env,
          PGPASSWORD: 'unrelated-host-password',
          SOMS_DOMAIN: 'unrelated-host.example',
          SOMS_ENV_FILE: 'missing.env',
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr.trim(), '', 'Unexpected Compose warning');
    return JSON.parse(result.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test(
  'NAS configuration resolves without an env file or host configuration',
  options,
  () => {
    const { services } = resolveConfig();
    assert.deepEqual(Object.keys(services).sort(), [
      'app',
      'migrate',
      'postgres',
    ]);
    for (const service of Object.values(services)) {
      assert.equal(service.env_file, undefined);
    }
    assert.equal(services.app.environment.SOMS_DOMAIN, 'example.com');
    assert.equal(services.postgres.environment.POSTGRES_PASSWORD, '');
    assert.equal(
      services.app.depends_on.migrate.condition,
      'service_completed_successfully',
    );
  },
);

test(
  'database anchors share credentials across all three services and escape dollars',
  options,
  () => {
    const source = template
      .replace(
        'PGDATABASE: &database-name soms',
        'PGDATABASE: &database-name custom_db',
      )
      .replace(
        'PGUSER: &database-user timescale',
        'PGUSER: &database-user custom_user',
      )
      .replace(
        "PGPASSWORD: &database-password ''",
        () => "PGPASSWORD: &database-password 'fixture-$$token:#'",
      );
    const { services } = resolveConfig(source);
    assert.deepEqual(services.postgres.environment, {
      POSTGRES_DB: 'custom_db',
      POSTGRES_USER: 'custom_user',
      // Canonical Compose output re-escapes literal dollars so it can be loaded again.
      POSTGRES_PASSWORD: 'fixture-$$token:#',
    });
    for (const service of [services.app, services.migrate]) {
      assert.equal(service.environment.PGDATABASE, 'custom_db');
      assert.equal(service.environment.PGUSER, 'custom_user');
      assert.equal(service.environment.PGPASSWORD, 'fixture-$$token:#');
      assert.equal(service.environment.PGHOST, 'postgres');
      assert.equal(service.environment.PGPORT, '5432');
    }
    // Compose retains the escape in the serialized command; the container shell expands it at runtime.
    assert.match(
      services.postgres.healthcheck.test[1],
      /\$\$\{POSTGRES_USER\}/,
    );
    assert.match(services.postgres.healthcheck.test[1], /\$\$\{POSTGRES_DB\}/);
  },
);

test(
  'Caddy receives native environment placeholders and app-only credentials',
  options,
  () => {
    const { services } = resolveConfig(
      template.replace(
        "CLOUDFLARE_API_TOKEN: ''",
        () => "CLOUDFLARE_API_TOKEN: 'fixture-$$token'",
      ),
    );
    assert.equal(
      services.app.environment.CADDY_DNS_DIRECTIVE,
      'dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
    );
    assert.equal(
      services.app.environment.CLOUDFLARE_API_TOKEN,
      'fixture-$$token',
    );
    for (const service of [services.postgres, services.migrate]) {
      assert.equal(service.environment.CLOUDFLARE_API_TOKEN, undefined);
      assert.equal(service.environment.ADMIN_BOOTSTRAP_PASSWORD, undefined);
    }
    assert.deepEqual(
      services.app.ports.map(({ target, published, protocol }) => ({
        target,
        published,
        protocol,
      })),
      [
        { target: 7667, published: '7667', protocol: 'tcp' },
        { target: 7667, published: '7667', protocol: 'udp' },
      ],
    );
  },
);
