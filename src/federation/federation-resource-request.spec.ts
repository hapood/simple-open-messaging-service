import { describe, expect, it } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import {
  encodeFederationResourceComponent,
  parseFederationRange,
  parseFederationResourceRequest,
  requireBundleId,
  requireSafeDecimal,
} from './federation-resource-request.js';

function request(
  url: string,
  options: {
    rawBody?: string;
    contentType?: string;
    contentLength?: string;
  } = {},
): FastifyRequest {
  return {
    method: 'GET',
    url,
    rawBody: Buffer.from(options.rawBody ?? ''),
    headers: {
      ...(options.contentType ? { 'content-type': options.contentType } : {}),
      ...(options.contentLength
        ? { 'content-length': options.contentLength }
        : {}),
    },
  } as FastifyRequest;
}

const mediaSpec = {
  pathPrefix: '/s2s/v1/media/',
  pathName: 'digest',
  query: [
    { name: 'fromAccount' },
    { name: 'fromDomain' },
    { name: 'toAccount' },
    { name: 'seq' },
    { name: 'bundleId', optional: true },
  ],
};

function expectMalformed(action: () => unknown): void {
  try {
    action();
    throw new Error('expected malformed request');
  } catch (error) {
    expect(error).toBeInstanceOf(BusinessException);
    expect((error as BusinessException).bizCode).toBe(
      BusinessCode.FEDERATION_MALFORMED,
    );
    expect((error as BusinessException).getStatus()).toBe(400);
  }
}

describe('Federation resource raw request validation', () => {
  it('uses canonical RFC 3986 encoding for resource components', () => {
    expect(encodeFederationResourceComponent('!group')).toBe('%21group');
    expect(encodeFederationResourceComponent('alice')).toBe('alice');
  });

  it('preserves the exact ordered media authorization query', () => {
    const digest = 'a'.repeat(64);
    const parsed = parseFederationResourceRequest(
      request(
        `/s2s/v1/media/${digest}?fromAccount=alice&fromDomain=a.example&toAccount=bob&seq=42&bundleId=root`,
      ),
      mediaSpec,
    );
    expect(parsed).toEqual({
      pathValue: digest,
      query: {
        fromAccount: 'alice',
        fromDomain: 'a.example',
        toAccount: 'bob',
        seq: '42',
        bundleId: 'root',
      },
    });
  });

  it.each([
    '?fromDomain=a.example&fromAccount=alice&toAccount=bob&seq=42',
    '?fromAccount=alice&fromAccount=alice&fromDomain=a.example&toAccount=bob&seq=42',
    '?fromAccount=alice&fromDomain=a.example&toAccount=bob&seq=42&unknown=x',
  ])('rejects unknown, duplicate, or out-of-order query: %s', (query) => {
    expectMalformed(() =>
      parseFederationResourceRequest(
        request(`/s2s/v1/media/${'a'.repeat(64)}${query}`),
        mediaSpec,
      ),
    );
  });

  it('rejects a GET body, Content-Type, and non-zero Content-Length', () => {
    const url = '/s2s/v1/accounts/alice';
    const spec = { pathPrefix: '/s2s/v1/accounts/', pathName: 'account' };
    expectMalformed(() =>
      parseFederationResourceRequest(request(url, { rawBody: '{}' }), spec),
    );
    expectMalformed(() =>
      parseFederationResourceRequest(
        request(url, { contentType: 'application/json' }),
        spec,
      ),
    );
    expectMalformed(() =>
      parseFederationResourceRequest(
        request(url, { contentLength: '1' }),
        spec,
      ),
    );
  });

  it('rejects values outside the safe seq and bundle ID bounds', () => {
    expectMalformed(() => requireSafeDecimal('9007199254740992', 'seq'));
    expectMalformed(() => requireBundleId('x'.repeat(27)));
  });
});

describe('Federation media Range parsing', () => {
  it.each([
    [undefined, 10, { kind: 'none' }],
    ['bytes=0-4', 10, { kind: 'valid', start: 0, end: 4 }],
    ['bytes=5-', 10, { kind: 'valid', start: 5, end: 9 }],
    ['bytes=-3', 10, { kind: 'valid', start: 7, end: 9 }],
    ['bytes=0-99', 10, { kind: 'valid', start: 0, end: 9 }],
    ['bytes=10-20', 10, { kind: 'unsatisfiable' }],
    ['bytes=5-4', 10, { kind: 'unsatisfiable' }],
    ['bytes=0-1', 0, { kind: 'unsatisfiable' }],
    ['hello', 10, { kind: 'malformed' }],
    ['bytes=0-1,3-4', 10, { kind: 'malformed' }],
    ['bytes=-0', 10, { kind: 'malformed' }],
  ] as const)('maps %s with length %s', (header, total, expected) => {
    expect(parseFederationRange(header, total)).toEqual(expected);
  });
});
