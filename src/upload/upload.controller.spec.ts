import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { UploadController } from './upload.controller.js';

function setup(clientMessageId?: string) {
  const uploadService = {
    consumeFile: vi.fn().mockResolvedValue({
      kind: 'accepted',
      mimetype: 'application/octet-stream',
      filename: 'data.bin',
      buffer: Buffer.from('quota bytes'),
    }),
    saveFile: vi.fn().mockResolvedValue({
      url: '/uploads/shards/aa/digest',
      name: 'data.bin',
      size: 11,
      mimeType: 'application/octet-stream',
    }),
  };
  const messageService = {
    failStaged: vi.fn().mockResolvedValue(undefined),
    linkStagedDigest: vi.fn().mockResolvedValue(undefined),
    promoteStaged: vi.fn().mockResolvedValue(null),
  };
  const userQuota = {
    assertWithinByteCap: vi.fn().mockResolvedValue(undefined),
    tickStandalone: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new UploadController(
    uploadService as never,
    messageService as never,
    { dispatch: vi.fn() } as never,
    userQuota as never,
    {} as never,
  );
  const req = {
    user: { userId: 7 },
    headers: clientMessageId ? { 'x-client-message-id': clientMessageId } : {},
  } as unknown as FastifyRequest;
  return { controller, uploadService, messageService, userQuota, req };
}

describe('UploadController quota admission', () => {
  it('checks the byte cap but does not count a staged file twice', async () => {
    const { controller, uploadService, userQuota, req } = setup('stage-1');

    await controller.uploadFile(req);

    expect(userQuota.assertWithinByteCap).toHaveBeenCalledWith(
      7,
      'largeFiles',
      11,
    );
    expect(userQuota.tickStandalone).not.toHaveBeenCalled();
    expect(uploadService.saveFile).toHaveBeenCalledOnce();
  });

  it('counts a plain upload before persisting it', async () => {
    const { controller, uploadService, userQuota, req } = setup();

    await controller.uploadFile(req);

    expect(userQuota.tickStandalone).toHaveBeenCalledWith(7, 'largeFiles');
    expect(userQuota.tickStandalone.mock.invocationCallOrder[0]).toBeLessThan(
      uploadService.saveFile.mock.invocationCallOrder[0],
    );
  });

  it('marks a staged upload failed and skips persistence when quota rejects it', async () => {
    const { controller, uploadService, messageService, userQuota, req } =
      setup('stage-2');
    userQuota.assertWithinByteCap.mockRejectedValue(
      new BusinessException(BusinessCode.QUOTA_EXCEEDED, 'quota exceeded'),
    );

    await expect(controller.uploadFile(req)).rejects.toMatchObject({
      bizCode: BusinessCode.QUOTA_EXCEEDED,
    });

    expect(messageService.failStaged).toHaveBeenCalledWith(
      7,
      'stage-2',
      'quota exceeded',
    );
    expect(uploadService.saveFile).not.toHaveBeenCalled();
  });
});
