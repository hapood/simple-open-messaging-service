import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { ClientIdentityService } from './client-identity.service.js';

const originalTrustedProxies = process.env.TRUSTED_PROXY_CIDRS;

afterEach(() => {
  if (originalTrustedProxies === undefined)
    delete process.env.TRUSTED_PROXY_CIDRS;
  else process.env.TRUSTED_PROXY_CIDRS = originalTrustedProxies;
});

function request(remoteAddress: string, forwardedFor?: string): FastifyRequest {
  return {
    raw: { socket: { remoteAddress } },
    headers: {
      ...(forwardedFor ? { 'x-forwarded-for': forwardedFor } : {}),
    },
  } as unknown as FastifyRequest;
}

describe('ClientIdentityService', () => {
  it('trusts no proxy by default', () => {
    delete process.env.TRUSTED_PROXY_CIDRS;
    const identity = new ClientIdentityService().fromRequest(
      request('127.0.0.1', '2001:db8::123'),
    );
    expect(identity?.address).toBe('127.0.0.1');
  });

  it('trusts loopback only when it is explicitly configured', () => {
    process.env.TRUSTED_PROXY_CIDRS = '127.0.0.0/8,::1/128';
    const identity = new ClientIdentityService().fromRequest(
      request('127.0.0.1', '2001:db8::123'),
    );
    expect(identity?.address).toBe('2001:db8::123');
  });

  it('ignores forwarded data when the raw peer is not explicitly trusted', () => {
    process.env.TRUSTED_PROXY_CIDRS = '127.0.0.0/8';
    const identity = new ClientIdentityService().fromRequest(
      request('203.0.113.8', '198.51.100.9'),
    );
    expect(identity?.address).toBe('203.0.113.8');
  });

  it('can explicitly trust no proxy when Fastify is the public edge', () => {
    process.env.TRUSTED_PROXY_CIDRS = '';
    const identity = new ClientIdentityService().fromRequest(
      request('127.0.0.1', '198.51.100.9'),
    );
    expect(identity?.address).toBe('127.0.0.1');
  });

  it('rejects invalid proxy configuration during construction', () => {
    process.env.TRUSTED_PROXY_CIDRS = 'not-a-cidr';
    expect(() => new ClientIdentityService()).toThrow(
      'invalid TRUSTED_PROXY_CIDRS entry: not-a-cidr',
    );
  });
});
