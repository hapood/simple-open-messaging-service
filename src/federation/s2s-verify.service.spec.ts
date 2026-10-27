import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { S2sVerifyService } from './s2s-verify.service.js';

describe('S2sVerifyService signer metadata classification', () => {
  it('exposes the parsed signature creation time in seconds', () => {
    const service = new S2sVerifyService(
      {
        hasValidMetadata: () => true,
        parseMetadata: () => ({
          keyId: 'peer.example/key-1',
          created: 1700000000,
          expires: 1700000300,
        }),
      } as never,
      {} as never,
    );
    expect(service.parseSigner({} as never)).toEqual({
      keyId: 'peer.example/key-1',
      domain: 'peer.example',
      created: 1700000000,
      expires: 1700000300,
    });
  });
  it.each([
    {
      name: 'invalid signature metadata',
      signature: {
        hasValidMetadata: vi.fn().mockReturnValue(false),
        parseMetadata: vi.fn(),
      },
    },
    {
      name: 'missing parsed metadata',
      signature: {
        hasValidMetadata: vi.fn().mockReturnValue(true),
        parseMetadata: vi.fn().mockReturnValue(null),
      },
    },
    {
      name: 'empty signer domain',
      signature: {
        hasValidMetadata: vi.fn().mockReturnValue(true),
        parseMetadata: vi.fn().mockReturnValue({ keyId: '/key-1', expires: 1 }),
      },
    },
  ])('returns HTTP 400 for $name', ({ signature }) => {
    const service = new S2sVerifyService(signature as never, {} as never);

    expect(() => service.parseSigner({} as never)).toThrowError(
      expect.objectContaining({
        bizCode: BusinessCode.FEDERATION_MALFORMED,
        status: 400,
      }),
    );
  });
});
