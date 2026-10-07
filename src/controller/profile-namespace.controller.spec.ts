import { describe, expect, it, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ProfileNamespaceController } from './profile-namespace.controller.js';
import { BusinessCode } from '../common/business-code.js';

function harness(resolution: unknown = { status: 'READY', entry: {} }) {
  const namespaceInfo = {
    resolveOne: vi.fn().mockResolvedValue(resolution),
  };
  const refresh = { scheduleRefresh: vi.fn() };
  const controller = new ProfileNamespaceController(
    namespaceInfo as never,
    refresh as never,
  );
  return { controller, namespaceInfo, refresh };
}

describe('ProfileNamespaceController', () => {
  it('resolves a single namespace pair and returns READY', async () => {
    const { controller, namespaceInfo, refresh } = harness({
      status: 'READY',
      entry: {
        publisherNamespaceId: 7,
        profileNamespaceId: 5,
        domain: 'peer.test',
        rootPublicKey: 'k'.repeat(43) + '=',
        updateFeedId: 3,
        expired: false,
        status: 'ACTIVE',
      },
    });
    const result = await controller.resolve({
      publisherNamespaceId: 7,
      profileNamespaceId: 5,
    });
    expect(namespaceInfo.resolveOne).toHaveBeenCalledWith({
      publisherNamespaceId: 7,
      profileNamespaceId: 5,
    });
    expect(result).toMatchObject({ status: 'READY' });
    expect(refresh.scheduleRefresh).not.toHaveBeenCalled();
  });

  it('schedules a refresh and returns PENDING for a missing pair', async () => {
    const { controller, namespaceInfo, refresh } = harness({
      status: 'PENDING',
    });
    const result = await controller.resolve({
      publisherNamespaceId: 7,
      profileNamespaceId: 9,
    });
    expect(namespaceInfo.resolveOne).toHaveBeenCalledWith({
      publisherNamespaceId: 7,
      profileNamespaceId: 9,
    });
    expect(result).toEqual({ status: 'PENDING' });
    expect(refresh.scheduleRefresh).toHaveBeenCalledWith(
      { publisherNamespaceId: 7, profileNamespaceId: 9 },
      0n,
    );
  });

  const invalidBodies: Array<[string, unknown]> = [
    ['missing body', undefined],
    ['not an object', 'nope'],
    ['is an array', [7, 5]],
    ['missing publisherNamespaceId', { profileNamespaceId: 5 }],
    ['missing profileNamespaceId', { publisherNamespaceId: 7 }],
    [
      'non-numeric publisherNamespaceId',
      { publisherNamespaceId: '7', profileNamespaceId: 5 },
    ],
    [
      'non-numeric profileNamespaceId',
      { publisherNamespaceId: 7, profileNamespaceId: '5' },
    ],
    ['extra key', { publisherNamespaceId: 7, profileNamespaceId: 5, extra: 1 }],
  ];

  it.each(invalidBodies)(
    'rejects %s with VALIDATION_FAILED',
    async (_label, dto) => {
      const { controller, namespaceInfo } = harness();
      await expect(controller.resolve(dto)).rejects.toMatchObject({
        bizCode: BusinessCode.VALIDATION_FAILED,
        status: HttpStatus.BAD_REQUEST,
      });
      expect(namespaceInfo.resolveOne).not.toHaveBeenCalled();
    },
  );
});
