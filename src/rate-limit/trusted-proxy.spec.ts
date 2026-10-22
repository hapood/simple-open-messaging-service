import { describe, expect, it } from 'vitest';
import { parseTrustedProxyConfig } from './trusted-proxy.js';

describe('parseTrustedProxyConfig', () => {
  it('trusts no address when configuration is absent', () => {
    const config = parseTrustedProxyConfig(undefined);
    expect(config.cidrs).toEqual([]);
    expect(config.trustAllCidrs).toEqual([]);
    expect(config.isTrusted('127.0.0.1')).toBe(false);
  });

  it('identifies trust-all IPv4 and IPv6 ranges for startup warnings', () => {
    expect(
      parseTrustedProxyConfig('0.0.0.0/0, ::/0, 127.0.0.0/8').trustAllCidrs,
    ).toEqual(['0.0.0.0/0', '::/0']);
  });

  it('matches explicit IPv4 and IPv6 proxy ranges', () => {
    const config = parseTrustedProxyConfig('10.20.0.0/16, fd12:3456:789a::/64');
    expect(config.isTrusted('10.20.1.4')).toBe(true);
    expect(config.isTrusted('10.21.1.4')).toBe(false);
    expect(config.isTrusted('fd12:3456:789a::4')).toBe(true);
    expect(config.isTrusted('fd12:3456:789b::4')).toBe(false);
  });

  it('treats IPv4-mapped IPv6 as the equivalent IPv4 address', () => {
    const config = parseTrustedProxyConfig('192.0.2.0/24');
    expect(config.isTrusted('::ffff:192.0.2.5')).toBe(true);
  });

  it('rejects an invalid CIDR instead of silently weakening trust', () => {
    expect(() => parseTrustedProxyConfig('127.0.0.1/8,garbage')).toThrow(
      'invalid TRUSTED_PROXY_CIDRS entry: garbage',
    );
  });
});
