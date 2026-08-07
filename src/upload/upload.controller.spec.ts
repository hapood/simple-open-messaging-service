import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ContentType } from '../database/enums.js';
import { UploadController } from './upload.controller.js';

function setup({
  clientMessageId = 'stage-1',
  intent = ContentType.IMAGE,
  files = [
    { mimetype: 'image/png', buffer: Buffer.from('png bytes'), filename: 'a.png' },
  ],
  fields = { w: '10', h: '20' },
}: {
  clientMessageId?: string | undefined;
  intent?: ContentType | null;
  files?: Array<{ mimetype: string; buffer: Buffer; filename?: string }>;
  fields?: Record<string, string>;
} = {}) {
  const uploadService = {
    consumeParts: vi
      .fn()
      .mockResolvedValue({ kind: 'ok', files, fields }),
    detectFamily: vi.fn().mockReturnValue('IMAGE'),
    savePart: vi.fn().mockResolvedValue({
      payload: {
        digest: 'd'.repeat(64),
        url: '/uploads/msg-assets/dd/dd/' + 'd'.repeat(64),
        size: 9,
        family: 'IMAGE',
        w: 10,
        h: 20,
      },
    }),
  };
  const messageService = {
    getStagedIntent: vi.fn().mockResolvedValue(intent),
    markOutboundFileSucceeded: vi.fn().mockResolvedValue(null),
    failStaged: vi.fn().mockResolvedValue(undefined),
  };
  const userQuota = {
    assertWithinByteCap: vi.fn().mockResolvedValue(undefined),
    tickStandalone: vi.fn().mockResolvedValue(undefined),
  };
  const fanout = { dispatch: vi.fn() };
  const controller = new UploadController(
    uploadService as never,
    messageService as never,
    fanout as never,
    userQuota as never,
    {} as never,
  );
  const req = {
    user: { userId: 7 },
    headers: clientMessageId
      ? { 'x-client-message-id': clientMessageId }
      : {},
  } as unknown as FastifyRequest;
  return {
    controller,
    uploadService,
    messageService,
    userQuota,
    fanout,
    req,
  };
}

describe('UploadController type-agnostic upload (Phase 7)', () => {
  it('admits + ticks each file by detected family, then promotes at the barrier', async () => {
    const { controller, uploadService, userQuota, messageService, req } =
      setup();

    await controller.upload(req);

    // Quota BEFORE save: family detected from bytes, byte cap + count tick by family.
    expect(uploadService.detectFamily).toHaveBeenCalledOnce();
    expect(userQuota.assertWithinByteCap).toHaveBeenCalledWith(
      7,
      'images',
      9, // buffer length
    );
    expect(userQuota.tickStandalone).toHaveBeenCalledWith(7, 'images', 1);
    expect(userQuota.tickStandalone.mock.invocationCallOrder[0]).toBeLessThan(
      uploadService.savePart.mock.invocationCallOrder[0],
    );
    expect(uploadService.savePart).toHaveBeenCalledOnce();
    expect(messageService.markOutboundFileSucceeded).toHaveBeenCalledWith(
      'stage-1',
      'd'.repeat(64),
      expect.objectContaining({ family: 'IMAGE' }),
      7,
      undefined,
    );
  });

  it('fires fan-out exactly once when this call newly promotes the batch', async () => {
    const { controller, messageService, fanout, req } = setup();
    messageService.markOutboundFileSucceeded.mockResolvedValue({
      message: { seq: 5 },
      newlyPromoted: true,
    });

    await controller.upload(req);

    expect(fanout.dispatch).toHaveBeenCalledOnce();
    expect(fanout.dispatch).toHaveBeenCalledWith({ seq: 5 });
  });

  it('does not fan-out when the barrier is not yet met (more files to come)', async () => {
    const { controller, fanout, req } = setup();
    // markOutboundFileSucceeded resolves null while fileCnt is not yet reached.
    await controller.upload(req);
    expect(fanout.dispatch).not.toHaveBeenCalled();
  });

  it('rejects without an x-client-message-id header', async () => {
    const { controller, req } = setup({ clientMessageId: '' });
    await expect(controller.upload(req)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
  });

  it('fails the stage when there is no pending send for the clientMessageId', async () => {
    const { controller, messageService, uploadService, req } = setup({
      intent: null,
    });
    await expect(controller.upload(req)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
    expect(messageService.failStaged).toHaveBeenCalledWith(
      7,
      'stage-1',
      'media send is not pending',
    );
    expect(uploadService.savePart).not.toHaveBeenCalled();
  });

  it('marks the stage failed and skips save when quota rejects the byte cap', async () => {
    const { controller, messageService, uploadService, userQuota, req } =
      setup();
    userQuota.assertWithinByteCap.mockRejectedValue(
      new BusinessException(BusinessCode.QUOTA_EXCEEDED, 'quota exceeded'),
    );

    await expect(controller.upload(req)).rejects.toMatchObject({
      bizCode: BusinessCode.QUOTA_EXCEEDED,
    });

    expect(messageService.failStaged).toHaveBeenCalledWith(
      7,
      'stage-1',
      'quota exceeded',
    );
    expect(uploadService.savePart).not.toHaveBeenCalled();
  });
});
