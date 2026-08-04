import { describe, expect, it } from 'vitest';
import {
  normalizeClientAddress,
  resolveClientAddress,
} from './client-address.js';

describe('normalizeClientAddress', () => {
  it('canonicalizes IPv4-mapped IPv6 into the IPv4 identity', () => {
    expect(normalizeClientAddress('::ffff:192.0.2.10')).toEqual(
      normalizeClientAddress('192.0.2.10'),
    );
  });

  it('canonicalizes compressed and expanded IPv6 notation', () => {
    expect(normalizeClientAddress('2001:db8::1')).toEqual(
      normalizeClientAddress('2001:0db8:0:0:0:0:0:1'),
    );
  });

  it('groups temporary addresses by /64 while retaining distinct exact subjects', () => {
    const first = normalizeClientAddress('2001:db8:1:2::1');
    const second = normalizeClientAddress('2001:db8:1:2:ffff::abcd');
    expect(first?.exactSubject).not.toBe(second?.exactSubject);
    expect(first?.family).toBe('ipv6');
    expect(second?.family).toBe('ipv6');
    if (first?.family === 'ipv6' && second?.family === 'ipv6') {
      expect(first.prefix64Subject).toBe(second.prefix64Subject);
    }
  });

  it('keeps different /64 prefixes separate', () => {
    const first = normalizeClientAddress('2001:db8:1:2::1');
    const second = normalizeClientAddress('2001:db8:1:3::1');
    if (first?.family === 'ipv6' && second?.family === 'ipv6') {
      expect(first.prefix64Subject).not.toBe(second.prefix64Subject);
    } else {
      throw new Error('expected IPv6 identities');
    }
  });

  it('rejects zone identifiers and malformed input', () => {
    expect(normalizeClientAddress('fe80::1%eth0')).toBeUndefined();
    expect(normalizeClientAddress('not-an-ip')).toBeUndefined();
  });
});

describe('resolveClientAddress', () => {
  const trustedProxyCidrs = ['127.0.0.0/8', '::1/128'];

  it('ignores a spoofed forwarding header from an untrusted TCP peer', () => {
    expect(
      resolveClientAddress({
        remoteAddress: '203.0.113.7',
        forwardedFor: '198.51.100.2',
        trustedProxyCidrs,
      })?.address,
    ).toBe('203.0.113.7');
  });

  it('accepts the client supplied by the trusted loopback proxy', () => {
    expect(
      resolveClientAddress({
        remoteAddress: '127.0.0.1',
        forwardedFor: '2001:db8::1234',
        trustedProxyCidrs,
      })?.address,
    ).toBe('2001:db8::1234');
  });

  it('walks a chain of explicitly trusted proxies from right to left', () => {
    expect(
      resolveClientAddress({
        remoteAddress: '127.0.0.1',
        forwardedFor: '2001:db8::5, 10.0.0.4',
        trustedProxyCidrs: [...trustedProxyCidrs, '10.0.0.0/8'],
      })?.address,
    ).toBe('2001:db8::5');
  });

  it('stops at the first untrusted hop in a mixed proxy chain', () => {
    expect(
      resolveClientAddress({
        remoteAddress: '127.0.0.1',
        forwardedFor: '198.51.100.9, 203.0.113.7, 10.0.0.4',
        trustedProxyCidrs: [...trustedProxyCidrs, '10.0.0.0/8'],
      })?.address,
    ).toBe('203.0.113.7');
  });

  it('fails closed to the TCP peer for a malformed forwarding chain', () => {
    expect(
      resolveClientAddress({
        remoteAddress: '127.0.0.1',
        forwardedFor: 'garbage, 198.51.100.3',
        trustedProxyCidrs,
      })?.address,
    ).toBe('127.0.0.1');
  });
});
