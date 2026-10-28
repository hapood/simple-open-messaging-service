import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { UploadController } from './upload.controller.js';
import { BusinessCode } from '../common/business-code.js';

const req = { user: { userId: 7 } } as FastifyRequest;
describe('UploadController avatar transport', () => {
  it('preserves the independent avatar multipart pipeline', async () => {
    const buffer = Buffer.from('image');
    const upload = {
      consumeImage: vi
        .fn()
        .mockResolvedValue({ kind: 'file', buffer, mimetype: 'image/png' }),
      isImage: vi.fn().mockReturnValue(true),
      saveAvatar: vi.fn().mockResolvedValue('/uploads/avatars/test.png'),
    };
    const controller = new UploadController(upload as never, {} as never);
    expect(await controller.uploadAvatar(req)).toEqual({
      avatar: '/uploads/avatars/test.png',
    });
    expect(upload.saveAvatar).toHaveBeenCalledWith(buffer);
  });
  it.each(['no-file', 'wrong-type', 'too-large'])(
    'rejects an invalid avatar part: %s',
    async (reason) => {
      const controller = new UploadController(
        {
          consumeImage: vi.fn().mockResolvedValue({ kind: 'rejected', reason }),
        } as never,
        {} as never,
      );
      await expect(controller.uploadAvatar(req)).rejects.toMatchObject({
        bizCode: BusinessCode.VALIDATION_FAILED,
      });
    },
  );
});
