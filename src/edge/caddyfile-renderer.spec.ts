import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EdgeConfigError,
  parseEdgeConfig,
  renderCaddyfile,
} from './caddyfile-renderer.js';

/** Golden configurations for the renderer, including identity/application host
 * boundaries. Scenarios below define each fixture's complete environment. */
const FIXTURES = join(__dirname, 'fixtures');

const BASE_ENV: NodeJS.ProcessEnv = {
  SOMS_TLS_MODE: 'single-port',
  SOMS_DOMAIN: 'test.local',
  SOMS_WEB_DOMAIN: 'web.test.local',
  CLOUDFLARE_API_TOKEN: 'cf-token',
  CADDY_DNS_DIRECTIVE: 'dns cloudflare {env.CLOUDFLARE_API_TOKEN}',
};

/** Env per fixture file, mirroring the capture commands. */
const SCENARIOS: Record<string, NodeJS.ProcessEnv> = {
  's1-default': {},
  's2-rich': {
    SOMS_LAN_DOMAIN: 'lan.test.local',
    SOMS_ADMIN_ACCESS: 'lan',
    SOMS_BACKEND_SOCKET: '/tmp/soms/backend.sock',
    SOMS_EDGE_PORT: '7668',
  },
  's3-disabled': {
    SOMS_TLS_MODE: 'disabled',
    SOMS_LAN_DOMAIN: 'lan.test.local',
    SOMS_ADMIN_ACCESS: 'lan',
    SOMS_BACKEND_SOCKET: '/tmp/soms/backend.sock',
    SOMS_EDGE_PORT: '7668',
  },
  's4-standard': { SOMS_TLS_MODE: 'standard' },
  's5-standard-lan': {
    SOMS_TLS_MODE: 'standard',
    SOMS_LAN_DOMAIN: 'lan.test.local',
    SOMS_ADMIN_ACCESS: 'lan',
    SOMS_BACKEND_SOCKET: '/tmp/soms/backend.sock',
  },
  's6-alpn-email': {
    SOMS_TLS_MODE: 'standard',
    CADDY_CERT_MODE: 'alpn',
    ACME_EMAIL: 'admin@test.local',
    CADDY_DNS_DIRECTIVE: '',
    CLOUDFLARE_API_TOKEN: '',
  },
  's7-alpn': {
    SOMS_TLS_MODE: 'standard',
    CADDY_CERT_MODE: 'alpn',
    CADDY_DNS_DIRECTIVE: '',
    CLOUDFLARE_API_TOKEN: '',
  },
  's8-alpn-zerossl-web': {
    SOMS_TLS_MODE: 'standard',
    CADDY_CERT_MODE: 'alpn',
    CADDY_DNS_DIRECTIVE: '',
    CLOUDFLARE_API_TOKEN: '',
    CADDY_ZEROSSL_API_KEY: 'zs-key',
    SOMS_WEB_DOMAIN: 'www2.test.local',
  },
  's9-covered-web': { SOMS_WEB_DOMAIN: 'chat.test.local' },
};

describe('Caddyfile renderer golden output', () => {
  for (const [name, overrides] of Object.entries(SCENARIOS)) {
    it(`matches the reviewed routing fixture: ${name}`, () => {
      const caddyfile = renderCaddyfile(
        parseEdgeConfig({ ...BASE_ENV, ...overrides }),
      );
      expect(caddyfile).toBe(
        readFileSync(join(FIXTURES, `${name}.conf`), 'utf8'),
      );
    });
  }
});

describe('Caddyfile renderer validation', () => {
  const render = (env: NodeJS.ProcessEnv) =>
    renderCaddyfile(parseEdgeConfig({ ...BASE_ENV, ...env }));

  it('rejects a missing or malformed identity domain', () => {
    expect(() => render({ SOMS_DOMAIN: '' })).toThrow(EdgeConfigError);
    expect(() => render({ SOMS_DOMAIN: 'https://x' })).toThrow(/bare domain/u);
  });

  it('rejects unknown TLS/cert/admin modes', () => {
    expect(() => render({ SOMS_TLS_MODE: 'tls' })).toThrow(/SOMS_TLS_MODE/u);
    expect(() => render({ CADDY_CERT_MODE: 'http' })).toThrow(
      /CADDY_CERT_MODE/u,
    );
    expect(() => render({ SOMS_ADMIN_ACCESS: 'everyone' })).toThrow(
      /SOMS_ADMIN_ACCESS/u,
    );
  });

  it('rejects TLS_CERT/TLS_KEY with the Caddy edge', () => {
    expect(() => render({ TLS_CERT: '/c.pem' })).toThrow(/conflicting TLS/u);
    expect(() =>
      render({ SOMS_TLS_MODE: 'disabled', TLS_CERT: '/c.pem' }),
    ).toThrow(/unsupported in the full Docker image/u);
  });

  it('keeps web/LAN domains inside the identity apex', () => {
    expect(() => render({ SOMS_WEB_DOMAIN: 'other.example' })).toThrow(
      /SOMS_WEB_DOMAIN/u,
    );
    expect(() => render({ SOMS_LAN_DOMAIN: 'lan.other.example' })).toThrow(
      /must share SOMS_DOMAIN's registrable domain/u,
    );
  });

  it('requires the DNS directive for DNS-01 and validates native env references', () => {
    expect(() => render({ CADDY_DNS_DIRECTIVE: '' })).toThrow(
      /CADDY_DNS_DIRECTIVE is required/u,
    );
    expect(() =>
      render({ CADDY_DNS_DIRECTIVE: 'dns cloudflare {TOKEN}' }),
    ).toThrow(/must use native \{env\.NAME\} references/u);
    expect(() =>
      render({ CADDY_DNS_DIRECTIVE: 'dns cloudflare {$TOKEN}' }),
    ).toThrow(/must use native \{env\.NAME\} references/u);
    expect(() =>
      render({ CADDY_DNS_DIRECTIVE: 'dns cloudflare {env.MISSING_TOKEN}' }),
    ).toThrow(/references \{env\.MISSING_TOKEN\} but it is not set/u);
  });

  it('guards ALPN mode to standard TLS without LAN domains and bare emails', () => {
    expect(() =>
      render({ CADDY_CERT_MODE: 'alpn', CADDY_DNS_DIRECTIVE: '' }),
    ).toThrow(/requires standard port 443/u);
    expect(() =>
      render({
        SOMS_TLS_MODE: 'standard',
        CADDY_CERT_MODE: 'alpn',
        SOMS_LAN_DOMAIN: 'lan.test.local',
        CADDY_DNS_DIRECTIVE: '',
      }),
    ).toThrow(/SOMS_LAN_DOMAIN requires DNS-01/u);
    expect(() =>
      render({
        SOMS_TLS_MODE: 'standard',
        CADDY_CERT_MODE: 'alpn',
        ACME_EMAIL: 'admin test@x',
        CADDY_DNS_DIRECTIVE: '',
      }),
    ).toThrow(/bare address without whitespace or braces/u);
  });

  it('infers cert mode: directive wins, standard without a directive defaults to alpn', () => {
    expect(render({}).match(/dns cloudflare/u)).toBeTruthy();
    const inferred = render({
      SOMS_TLS_MODE: 'standard',
      CADDY_DNS_DIRECTIVE: '',
    });
    expect(inferred).toContain('disable_http_challenge');
    expect(inferred).not.toContain('zerossl');
  });

  it('validates the backend socket path and edge port range', () => {
    expect(() => render({ SOMS_BACKEND_SOCKET: 'tmp/x' })).toThrow(
      /absolute path/u,
    );
    expect(() => render({ SOMS_EDGE_PORT: '70000' })).toThrow(/1-65535/u);
    expect(() => render({ SOMS_EDGE_PORT: 'https' })).toThrow(/1-65535/u);
  });

  it('keeps secrets out of the rendered file (native placeholders only)', () => {
    const caddyfile = render({});
    expect(caddyfile).not.toContain('cf-token');
    expect(caddyfile).toContain('{env.CLOUDFLARE_API_TOKEN}');
    const zerossl = render({
      SOMS_TLS_MODE: 'standard',
      CADDY_CERT_MODE: 'alpn',
      CADDY_DNS_DIRECTIVE: '',
      CADDY_ZEROSSL_API_KEY: 'zs-key',
    });
    expect(zerossl).not.toContain('zs-key');
    expect(zerossl).toContain('issuer zerossl {env.CADDY_ZEROSSL_API_KEY}');
  });
});
