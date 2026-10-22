import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  mintTurnCredential,
  buildIceServers,
  DEFAULT_TURN_TTL_SECONDS,
} from './turn-credentials.js';

describe('mintTurnCredential', () => {
  it('encodes <expiry>:<userId> as the username', () => {
    const c = mintTurnCredential('s3cr3t', 42, 600, 1_000_000);
    // expiry = now + ttl
    expect(c.username).toBe('1000600:42');
  });

  it('produces base64 HMAC-SHA1(secret, username) coturn expects', () => {
    const c = mintTurnCredential('s3cr3t', 42, 600, 1_000_000);
    const expected = createHmac('sha1', 's3cr3t')
      .update(c.username)
      .digest('base64');
    expect(c.credential).toBe(expected);
  });

  it('changes when the userId changes (per-user credentials)', () => {
    const a = mintTurnCredential('s3cr3t', 1, 600, 1_000_000);
    const b = mintTurnCredential('s3cr3t', 2, 600, 1_000_000);
    expect(a.username).not.toBe(b.username);
    expect(a.credential).not.toBe(b.credential);
  });
});

describe('buildIceServers', () => {
  it('returns STUN-only when TURN env is unset', () => {
    const { iceServers } = buildIceServers(7, 1_000_000);
    expect(iceServers).toHaveLength(0); // nothing configured
  });

  it('includes STUN when SOMS_STUN_URLS is set', () => {
    process.env.SOMS_STUN_URLS = 'stun:turn.example:3478';
    try {
      const { iceServers } = buildIceServers(7, 1_000_000);
      expect(iceServers).toEqual([{ urls: 'stun:turn.example:3478' }]);
    } finally {
      delete process.env.SOMS_STUN_URLS;
    }
  });

  it('adds TURN REST creds when SOMS_TURN_URLS + SOMS_TURN_REST_SECRET are set', () => {
    process.env.SOMS_STUN_URLS = 'stun:turn.example:3478';
    process.env.SOMS_TURN_URLS =
      'turn:turn.example:3478?transport=udp,turns:turn.example:5349?transport=tcp';
    process.env.SOMS_TURN_REST_SECRET = 's3cr3t';
    process.env.SOMS_TURN_TTL = '600';
    try {
      const { iceServers } = buildIceServers(7, 1_000_000);
      expect(iceServers).toHaveLength(2);
      const turn = iceServers[1];
      expect(turn.urls).toEqual([
        'turn:turn.example:3478?transport=udp',
        'turns:turn.example:5349?transport=tcp',
      ]);
      // username carries the injected now + ttl
      expect(turn.username).toBe(`1000600:7`);
      // credential is the coturn HMAC
      expect(turn.credential).toBe(
        createHmac('sha1', 's3cr3t').update('1000600:7').digest('base64'),
      );
    } finally {
      delete process.env.SOMS_STUN_URLS;
      delete process.env.SOMS_TURN_URLS;
      delete process.env.SOMS_TURN_REST_SECRET;
      delete process.env.SOMS_TURN_TTL;
    }
  });

  it('throws when only SOMS_TURN_URLS is set (no shared secret) — fail loud on misconfiguration', () => {
    process.env.SOMS_STUN_URLS = 'stun:turn.example:3478';
    process.env.SOMS_TURN_URLS = 'turn:turn.example:3478';
    try {
      expect(() => buildIceServers(7, 1_000_000)).toThrow(
        /TURN misconfiguration/,
      );
    } finally {
      delete process.env.SOMS_STUN_URLS;
      delete process.env.SOMS_TURN_URLS;
    }
  });

  it('throws when only SOMS_TURN_REST_SECRET is set (no URLs) — symmetric misconfiguration', () => {
    process.env.SOMS_TURN_REST_SECRET = 's3cr3t';
    try {
      expect(() => buildIceServers(7, 1_000_000)).toThrow(
        /TURN misconfiguration/,
      );
    } finally {
      delete process.env.SOMS_TURN_REST_SECRET;
    }
  });

  it('returns empty when nothing is configured (dev with no coturn — not an error)', () => {
    const { iceServers } = buildIceServers(7, 1_000_000);
    expect(iceServers).toEqual([]);
  });

  it('uses the default 1h TTL constant', () => {
    expect(DEFAULT_TURN_TTL_SECONDS).toBe(3600);
  });
});
