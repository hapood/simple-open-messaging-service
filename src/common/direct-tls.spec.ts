import { describe, expect, it } from 'vitest';
import { resolveDirectTlsPaths } from './direct-tls.js';

describe('resolveDirectTlsPaths', () => {
  it('disables direct TLS when both paths are unset', () => {
    expect(resolveDirectTlsPaths({})).toBeUndefined();
    expect(
      resolveDirectTlsPaths({ TLS_CERT: '', TLS_KEY: '' }),
    ).toBeUndefined();
  });

  it('returns a complete certificate and key pair', () => {
    expect(
      resolveDirectTlsPaths({
        TLS_CERT: '/etc/ssl/chat/cert.pem',
        TLS_KEY: '/etc/ssl/chat/key.pem',
      }),
    ).toEqual({
      cert: '/etc/ssl/chat/cert.pem',
      key: '/etc/ssl/chat/key.pem',
    });
  });

  it('rejects either incomplete half of the pair', () => {
    expect(() =>
      resolveDirectTlsPaths({ TLS_CERT: '/etc/ssl/chat/cert.pem' }),
    ).toThrow('TLS_CERT and TLS_KEY must be configured together');
    expect(() =>
      resolveDirectTlsPaths({ TLS_KEY: '/etc/ssl/chat/key.pem' }),
    ).toThrow('TLS_CERT and TLS_KEY must be configured together');
  });
});
