import { describe, expect, it, vi } from 'vitest';
import { HttpStatus } from '@nestjs/common';
import { ProfileNamespaceController } from './profile-namespace.controller.js';
import { BusinessCode } from '../common/business-code.js';

function harness(result: unknown = { status: 'READY', entry: {} }) {
  const resolution = { resolveOne: vi.fn().mockResolvedValue(result) };
  return {
    controller: new ProfileNamespaceController(resolution as never),
    resolution,
  };
}

describe('ProfileNamespaceController', () => {
  it.each(['READY', 'PENDING'])(
    'delegates %s decisions to demand orchestration',
    async (status) => {
      const result =
        status === 'READY'
          ? { status, entry: { domain: 'peer.test' } }
          : { status };
      const { controller, resolution } = harness(result);
      const pair = { publisherNamespaceId: 7, profileNamespaceId: 5 };
      expect(await controller.resolve(pair)).toEqual(result);
      expect(resolution.resolveOne).toHaveBeenCalledWith(pair);
    },
  );

  const invalidBodies: Array<[string, unknown]> = [
    ['missing body', undefined],
    ['not an object', 'nope'],
    ['is an array', [7, 5]],
    ['missing publisherNamespaceId', { profileNamespaceId: 5 }],
    ['missing profileNamespaceId', { publisherNamespaceId: 5 }],
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
      const { controller, resolution } = harness();
      await expect(controller.resolve(dto)).rejects.toMatchObject({
        bizCode: BusinessCode.VALIDATION_FAILED,
        status: HttpStatus.BAD_REQUEST,
      });
      expect(resolution.resolveOne).not.toHaveBeenCalled();
    },
  );
});
