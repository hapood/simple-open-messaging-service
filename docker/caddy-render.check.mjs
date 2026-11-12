#!/usr/bin/env node
// Image-build gate for the Caddyfile renderer: renders the scenario matrix with the COMPILED
// renderer that ships in the image and adapts every output with the image's actual Caddy binary
// (its DNS-01 modules and issuer plugins). Replaces the historic docker/init.test.sh shell gate.
// The Dockerfile bind-mounts docker/ at /checks and runs:
//   CADDY_BIN=/usr/bin/caddy node /checks/caddy-render.check.mjs
// Local runs (source checkout) work after `npm run build:be` with CADDY_BIN pointing at a real
// caddy binary; SOMS_IMAGE_ROOT overrides the image root (/app by default).
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const caddyBin = process.env.CADDY_BIN || 'caddy';
const imageRoot = process.env.SOMS_IMAGE_ROOT || '/app';

const failures = [];
const check = (label, condition, detail = '') => {
  const mark = condition ? 'ok' : `FAIL${detail ? `: ${detail}` : ''}`;
  console.log(`[caddy-render-check] ${label} — ${mark}`);
  if (!condition) failures.push(label);
};

const { parseEdgeConfig, renderCaddyfile, EdgeConfigError } = await import(
  pathToFileURL(join(imageRoot, 'dist/src/edge/caddyfile-renderer.js')).href
);
const cli = join(imageRoot, 'dist/scripts/render-caddyfile.js');

const BASE_ENV = {
  SOMS_TLS_MODE: 'single-port',
  SOMS_DOMAIN: 'test.local',
  SOMS_WEB_DOMAIN: 'web.test.local',
  CLOUDFLARE_API_TOKEN: 'cf-token',
  CADDY_DNS_DIRECTIVE: 'dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
};

const SCENARIOS = {
  'single-port default': {},
  'single-port rich': {
    SOMS_LAN_DOMAIN: 'lan.test.local',
    SOMS_ADMIN_ACCESS: 'lan',
    SOMS_BACKEND_SOCKET: '/tmp/soms/backend.sock',
    SOMS_EDGE_PORT: '7668',
  },
  disabled: {
    SOMS_TLS_MODE: 'disabled',
    SOMS_LAN_DOMAIN: 'lan.test.local',
    SOMS_ADMIN_ACCESS: 'lan',
    SOMS_BACKEND_SOCKET: '/tmp/soms/backend.sock',
    SOMS_EDGE_PORT: '7668',
  },
  'standard dns': { SOMS_TLS_MODE: 'standard' },
  'standard dns lan+socket': {
    SOMS_TLS_MODE: 'standard',
    SOMS_LAN_DOMAIN: 'lan.test.local',
    SOMS_ADMIN_ACCESS: 'lan',
    SOMS_BACKEND_SOCKET: '/tmp/soms/backend.sock',
  },
  'standard alpn email': {
    SOMS_TLS_MODE: 'standard',
    CADDY_CERT_MODE: 'alpn',
    ACME_EMAIL: 'admin@test.local',
    CADDY_DNS_DIRECTIVE: '',
    CLOUDFLARE_API_TOKEN: '',
  },
  'standard alpn': {
    SOMS_TLS_MODE: 'standard',
    CADDY_CERT_MODE: 'alpn',
    CADDY_DNS_DIRECTIVE: '',
    CLOUDFLARE_API_TOKEN: '',
  },
  'standard alpn zerossl': {
    SOMS_TLS_MODE: 'standard',
    CADDY_CERT_MODE: 'alpn',
    CADDY_DNS_DIRECTIVE: '',
    CLOUDFLARE_API_TOKEN: '',
    CADDY_ZEROSSL_API_KEY: 'zs-key',
    SOMS_WEB_DOMAIN: 'www2.test.local',
  },
  'covered web domain': { SOMS_WEB_DOMAIN: 'chat.test.local' },
};

const directory = mkdtempSync(join(tmpdir(), 'soms-caddy-render-'));
try {
  // --- 1. Every scenario renders, contains no credential values, and adapts under real Caddy ---
  for (const [label, overrides] of Object.entries(SCENARIOS)) {
    const env = { ...BASE_ENV, ...overrides };
    let caddyfile;
    try {
      caddyfile = renderCaddyfile(parseEdgeConfig(env));
    } catch (error) {
      check(`render ${label}`, false, error.message);
      continue;
    }
    const leaksSecret =
      caddyfile.includes('cf-token') || caddyfile.includes('zs-key');
    check(`render ${label} (no credential values)`, !leaksSecret);
    const file = join(
      directory,
      `${label.replace(/[^a-z0-9]+/g, '-')}.caddyfile`,
    );
    writeFileSync(file, caddyfile);
    const adapt = spawnSync(
      caddyBin,
      ['adapt', '--config', file, '--adapter', 'caddyfile'],
      { encoding: 'utf8' },
    );
    check(`caddy adapt ${label}`, adapt.status === 0, adapt.stderr.trim());
  }

  // --- 2. Misconfigurations fail with precise messages instead of rendering garbage ---
  const FAILURE_CASES = [
    ['missing SOMS_DOMAIN', { SOMS_DOMAIN: '' }, /SOMS_DOMAIN is required/u],
    [
      'missing DNS directive',
      { CADDY_DNS_DIRECTIVE: '' },
      /CADDY_DNS_DIRECTIVE is required/u,
    ],
    [
      'unset env reference',
      { CADDY_DNS_DIRECTIVE: 'dns cloudflare {env.MISSING_TOKEN}' },
      /references \{env\.MISSING_TOKEN\} but it is not set/u,
    ],
    [
      'alpn without standard TLS',
      { CADDY_CERT_MODE: 'alpn', CADDY_DNS_DIRECTIVE: '' },
      /requires standard port 443/u,
    ],
    [
      'alpn with LAN domain',
      {
        SOMS_TLS_MODE: 'standard',
        CADDY_CERT_MODE: 'alpn',
        SOMS_LAN_DOMAIN: 'lan.test.local',
        CADDY_DNS_DIRECTIVE: '',
      },
      /SOMS_LAN_DOMAIN requires DNS-01/u,
    ],
    [
      'LAN domain outside apex',
      { SOMS_LAN_DOMAIN: 'lan.other.example' },
      /must share SOMS_DOMAIN's registrable domain/u,
    ],
  ];
  for (const [label, overrides, pattern] of FAILURE_CASES) {
    let message = '';
    try {
      renderCaddyfile(parseEdgeConfig({ ...BASE_ENV, ...overrides }));
    } catch (error) {
      message = error instanceof EdgeConfigError ? error.message : '';
    }
    check(`reject ${label}`, pattern.test(message), `got '${message}'`);
  }

  // --- 3. The CLI end-to-end: writes the file with mode 600 and fails non-zero on bad config ---
  const run = join(directory, 'cli-run');
  const cliOk = spawnSync('node', [cli], {
    env: { ...process.env, ...BASE_ENV, SOMS_RUN_DIR: run },
    encoding: 'utf8',
  });
  const caddyfile = join(run, 'Caddyfile');
  check(
    'cli renders and logs OK',
    cliOk.status === 0 && /init: OK —/u.test(cliOk.stderr),
    cliOk.stderr.trim(),
  );
  check(
    'cli output matches the renderer and stays private',
    readFileSync(caddyfile, 'utf8') ===
      renderCaddyfile(parseEdgeConfig(BASE_ENV)) &&
      (statSync(caddyfile).mode & 0o777) === 0o600,
  );
  const cliBad = spawnSync('node', [cli], {
    env: { ...process.env, ...BASE_ENV, SOMS_DOMAIN: '', SOMS_RUN_DIR: run },
    encoding: 'utf8',
  });
  check(
    'cli exits non-zero on misconfiguration',
    cliBad.status !== 0 && /init: ERROR —/u.test(cliBad.stderr),
    cliBad.stderr.trim(),
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}

if (failures.length) {
  console.error(
    `[caddy-render-check] ${failures.length} failure(s): ${failures.join('; ')}`,
  );
  process.exit(1);
}
console.log('[caddy-render-check] all renderer scenarios passed');
