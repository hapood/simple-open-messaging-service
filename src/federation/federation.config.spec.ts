import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadFederationConfig,
  loadFederationRuntimeConfig,
} from './federation.config.js';

afterEach(() => vi.unstubAllEnvs());

describe('federation configuration', () => {
  it('loads runtime configuration without requiring SOMS_DOMAIN', () => {
    vi.stubEnv('SOMS_DOMAIN', undefined);
    vi.stubEnv('SOMS_ALLOW_INSECURE_HTTP', undefined);
    expect(loadFederationRuntimeConfig().allowInsecureHttp).toBe(false);
  });

  it('trusts forwarded resource snapshots by default and supports explicit rebuild', () => {
    vi.stubEnv('SOMS_DOMAIN', 'aaa.test');
    vi.stubEnv('SOMS_FEDERATION_FORWARDED_RESOURCE_POLICY', undefined);
    expect(loadFederationConfig().forwardedResourcePolicy).toBe('trust');
    vi.stubEnv('SOMS_FEDERATION_FORWARDED_RESOURCE_POLICY', 'rebuild');
    expect(loadFederationConfig().forwardedResourcePolicy).toBe('rebuild');
  });

  it('rejects an unknown forwarded resource policy', () => {
    vi.stubEnv('SOMS_DOMAIN', 'aaa.test');
    vi.stubEnv('SOMS_FEDERATION_FORWARDED_RESOURCE_POLICY', 'passthrough');
    expect(() => loadFederationConfig()).toThrow('must be trust or rebuild');
  });

  it('fails closed if insecure federation is enabled in production', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('SOMS_DOMAIN', 'aaa.example');
    vi.stubEnv('SOMS_ALLOW_INSECURE_HTTP', '1');
    expect(() => loadFederationConfig()).toThrow('forbidden');
  });

  it('allows explicit insecure transport outside production', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('SOMS_ALLOW_INSECURE_HTTP', '1');
    expect(loadFederationRuntimeConfig().allowInsecureHttp).toBe(true);
  });

  it('accepts a .local domain as a normal canonical domain', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SOMS_DOMAIN', 'node.local');
    vi.stubEnv('SOMS_ALLOW_INSECURE_HTTP', undefined);
    expect(loadFederationConfig().domain).toBe('node.local');
  });
});
