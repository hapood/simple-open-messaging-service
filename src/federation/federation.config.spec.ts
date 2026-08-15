import { afterEach, describe, expect, it } from 'vitest';
import { loadFederationConfig } from './federation.config.js';

const saved = {
  nodeEnv: process.env.NODE_ENV,
  domain: process.env.SOMS_DOMAIN,
  insecure: process.env.SOMS_ALLOW_INSECURE_HTTP,
  routes: process.env.SOMS_DEV_FEDERATION_ROUTES,
};

afterEach(() => {
  for (const [name, value] of [
    ['NODE_ENV', saved.nodeEnv],
    ['SOMS_DOMAIN', saved.domain],
    ['SOMS_ALLOW_INSECURE_HTTP', saved.insecure],
    ['SOMS_DEV_FEDERATION_ROUTES', saved.routes],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('development federation routes', () => {
  it('loads canonical HTTP origins in a non-production insecure environment', () => {
    process.env.NODE_ENV = 'development';
    process.env.SOMS_DOMAIN = 'aaa.test';
    process.env.SOMS_ALLOW_INSECURE_HTTP = '1';
    process.env.SOMS_DEV_FEDERATION_ROUTES = '{"bbb.test":"http://app-b:3000"}';

    expect(loadFederationConfig().devRoutes).toEqual({
      'bbb.test': 'http://app-b:3000',
    });
  });

  it('fails closed if insecure federation is enabled in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SOMS_DOMAIN = 'aaa.example';
    process.env.SOMS_ALLOW_INSECURE_HTTP = '1';
    delete process.env.SOMS_DEV_FEDERATION_ROUTES;

    expect(() => loadFederationConfig()).toThrow('forbidden');
  });

  it('fails closed if a route variable exists in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.SOMS_DOMAIN = 'aaa.example';
    delete process.env.SOMS_ALLOW_INSECURE_HTTP;
    process.env.SOMS_DEV_FEDERATION_ROUTES = '{}';

    expect(() => loadFederationConfig()).toThrow('forbidden');
  });

  it('requires the explicit insecure transport switch', () => {
    process.env.NODE_ENV = 'development';
    process.env.SOMS_DOMAIN = 'aaa.test';
    delete process.env.SOMS_ALLOW_INSECURE_HTTP;
    process.env.SOMS_DEV_FEDERATION_ROUTES = '{"bbb.test":"http://app-b:3000"}';

    expect(() => loadFederationConfig()).toThrow(
      'requires SOMS_ALLOW_INSECURE_HTTP=1',
    );
  });

  it.each([
    '["http://app-b:3000"]',
    '{"BBB.test":"http://app-b:3000"}',
    '{"bbb.test":"https://app-b:3000"}',
    '{"bbb.test":"http://user:pass@app-b:3000"}',
    '{"bbb.test":"http://app-b:3000/path"}',
  ])('rejects unsafe or malformed routes: %s', (routes) => {
    process.env.NODE_ENV = 'test';
    process.env.SOMS_DOMAIN = 'aaa.test';
    process.env.SOMS_ALLOW_INSECURE_HTTP = '1';
    process.env.SOMS_DEV_FEDERATION_ROUTES = routes;

    expect(() => loadFederationConfig()).toThrow();
  });

  it.each(['local', 'node.local'])('rejects RFC 6762 domain %s', (domain) => {
    process.env.NODE_ENV = 'test';
    process.env.SOMS_DOMAIN = domain;
    delete process.env.SOMS_ALLOW_INSECURE_HTTP;
    delete process.env.SOMS_DEV_FEDERATION_ROUTES;

    expect(() => loadFederationConfig()).toThrow('RFC 6762 .local');
  });
});
