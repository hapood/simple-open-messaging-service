import { describe, expect, it } from 'vitest';
import { loadWebAuthnConfig } from './webauthn.config.js';

describe('loadWebAuthnConfig', () => {
  it('derives one RP ID for public and LAN sibling domains', () => {
    expect(
      loadWebAuthnConfig(
        {
          SOMS_DOMAIN: 'chat.example.com',
          SOMS_WEB_DOMAIN: 'web.example.com',
          SOMS_LAN_DOMAIN: 'local.example.com',
          SOMS_TLS_MODE: 'standard',
        },
        true,
      ),
    ).toEqual({
      rpId: 'example.com',
      allowedOrigins: ['https://web.example.com', 'https://local.example.com'],
      available: true,
    });
  });

  it('uses the public suffix list for multi-label public suffixes', () => {
    expect(
      loadWebAuthnConfig(
        {
          SOMS_DOMAIN: 'chat.example.co.uk',
          SOMS_WEB_DOMAIN: 'web.example.co.uk',
        },
        true,
      ).rpId,
    ).toBe('example.co.uk');
  });

  it('rejects entry points that cannot share a WebAuthn RP ID', () => {
    expect(() =>
      loadWebAuthnConfig(
        {
          SOMS_DOMAIN: 'chat.example.com',
          SOMS_LAN_DOMAIN: 'chat.example.net',
        },
        true,
      ),
    ).toThrow('must share one registrable domain for WebAuthn');
  });

  it('keeps explicit overrides compatible', () => {
    expect(
      loadWebAuthnConfig(
        {
          SOMS_DOMAIN: 'chat.example.com',
          SOMS_WEBAUTHN_RP_ID: 'auth.example.com:443',
          SOMS_WEBAUTHN_ALLOWED_ORIGINS:
            'https://one.example.com, https://two.example.com',
        },
        true,
      ),
    ).toMatchObject({
      rpId: 'auth.example.com',
      allowedOrigins: ['https://one.example.com', 'https://two.example.com'],
    });
  });

  it('keeps localhost development defaults', () => {
    expect(loadWebAuthnConfig({}, false)).toEqual({
      rpId: 'localhost',
      allowedOrigins: ['http://localhost:5180'],
      available: true,
    });
  });
});
