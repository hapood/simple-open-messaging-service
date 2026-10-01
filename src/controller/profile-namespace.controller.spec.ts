import { describe, expect, it, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ProfileNamespaceController } from './profile-namespace.controller.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

function harness() {
  const namespaceInfo = {
    resolveBatch: vi.fn().mockResolvedValue([
      {
        publisherNamespaceId: 7,
        profileNamespaceId: 5,
        domain: 'peer.test',
        rootPublicKey: 'k'.repeat(43) + '=',
        updateFeedId: 3,
        expired: false,
      },
    ]),
  };
  const controller = new ProfileNamespaceController(namespaceInfo as never);
  return { controller, namespaceInfo };
}

describe('ProfileNamespaceController', () => {
  it('resolves a batch of closed namespace pairs', async () => {
    const { controller, namespaceInfo } = harness();
    const result = await controller.resolve({
      pairs: [
        { publisherNamespaceId: 7, profileNamespaceId: 5 },
        { publisherNamespaceId: 7, profileNamespaceId: 6 },
      ],
    });
    expect(namespaceInfo.resolveBatch).toHaveBeenCalledWith([
      { publisherNamespaceId: 7, profileNamespaceId: 5 },
      { publisherNamespaceId: 7, profileNamespaceId: 6 },
    ]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]).toMatchObject({
      publisherNamespaceId: 7,
      profileNamespaceId: 5,
      domain: 'peer.test',
    });
  });

  it.each([
    ['missing pairs', { pairs: undefined }],
    ['pairs not an array', { pairs: 'nope' }],
    ['empty pairs', { pairs: [] }],
    [
      'too many pairs',
      {
        pairs: Array.from({ length: 101 }, () => ({
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
        })),
      },
    ],
    ['pair not an object', { pairs: ['nope'] }],
    ['pair is an array', { pairs: [[7, 5]] }],
    [
      'pair with extra key',
      { pairs: [{ publisherNamespaceId: 7, profileNamespaceId: 5, extra: 1 }] },
    ],
    [
      'pair missing publisherNamespaceId',
      { pairs: [{ profileNamespaceId: 5 }] },
    ],
    [
      'pair with non-numeric namespace id',
      { pairs: [{ publisherNamespaceId: '7', profileNamespaceId: 5 }] },
    ],
  ])('rejects %s with VALIDATION_FAILED', async (_label, dto) => {
    const { controller, namespaceInfo } = harness();
    await expect(controller.resolve(dto)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
      status: HttpStatus.BAD_REQUEST,
    });
    expect(namespaceInfo.resolveBatch).not.toHaveBeenCalled();
  });

  it('accepts a single pair at the boundary (100 pairs)', async () => {
    const { controller } = harness();
    const pairs = Array.from({ length: 100 }, (_, i) => ({
      publisherNamespaceId: 7,
      profileNamespaceId: i,
    }));
    await expect(controller.resolve({ pairs })).resolves.toBeDefined();
  });

  it('rejects a null body', async () => {
    const { controller } = harness();
    await expect(controller.resolve(null)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
  });
});
