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
    {
      mimetype: 'image/png',
      buffer: Buffer.from('png bytes'),
      filename: 'a.png',
    },
  ],
  fields = {
    partId: '11111111-1111-4111-8111-111111111111',
    position: '0',
    intent: 'IMAGE',
  },
}: {
  clientMessageId?: string | undefined;
  intent?: ContentType | null;
  files?: Array<{ mimetype: string; buffer: Buffer; filename?: string }>;
  fields?: Record<string, string>;
} = {}) {
  const uploadService = {
    consumeParts: vi.fn().mockResolvedValue({ kind: 'ok', files, fields }),
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
    assertCanSend: vi.fn().mockResolvedValue(undefined),
    preCheckFile: vi.fn().mockResolvedValue(undefined),
    tickLax: vi.fn().mockResolvedValue(undefined),
    tickFileBytes: vi.fn().mockResolvedValue(undefined),
  };
  const controller = new UploadController(
    uploadService as never,
    messageService as never,
    userQuota as never,
    {} as never,
  );
  const req = {
    user: { userId: 7 },
    headers: clientMessageId ? { 'x-client-message-id': clientMessageId } : {},
  } as unknown as FastifyRequest;
  return {
    controller,
    uploadService,
    messageService,
    userQuota,
    req,
  };
}

describe('UploadController type-agnostic upload (Phase 7)', () => {
  it('charges file cnt + bytes at admission before saving, then promotes at the barrier', async () => {
    const { controller, uploadService, userQuota, messageService, req } =
      setup();

    await controller.upload(req);

    // Quota BEFORE save: breaker gate + strict-before file claim + cnt/byte tick, type-agnostic.
    expect(userQuota.assertCanSend).toHaveBeenCalledWith(7);
    expect(userQuota.preCheckFile).toHaveBeenCalledWith(7, 1, 9n);
    expect(userQuota.tickLax).toHaveBeenCalledWith(7, 'files');
    expect(userQuota.tickFileBytes).toHaveBeenCalledWith(7, 9n);
    expect(userQuota.tickFileBytes.mock.invocationCallOrder[0]).toBeLessThan(
      uploadService.savePart.mock.invocationCallOrder[0],
    );
    expect(uploadService.savePart).toHaveBeenCalledOnce();
    expect(messageService.markOutboundFileSucceeded).toHaveBeenCalledWith(
      'stage-1',
      '11111111-1111-4111-8111-111111111111',
      0,
      'd'.repeat(64),
      expect.objectContaining({ family: 'IMAGE' }),
      7,
      undefined,
    );
  });

  it('uses shared message promotion when the batch completes', async () => {
    const { controller, messageService, req } = setup();
    messageService.markOutboundFileSucceeded.mockResolvedValue({
      message: { seq: 5 },
      newlyPromoted: true,
    });

    await controller.upload(req);
    expect(messageService.markOutboundFileSucceeded).toHaveBeenCalledOnce();
  });

  it('accepts an uploaded part while the message barrier is not yet met', async () => {
    const { controller, messageService, req } = setup();
    // markOutboundFileSucceeded resolves null while fileCnt is not yet reached.
    await controller.upload(req);
    expect(messageService.markOutboundFileSucceeded).toHaveBeenCalledOnce();
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

  it('marks the stage failed and skips save when quota rejects the file claim', async () => {
    const { controller, messageService, uploadService, userQuota, req } =
      setup();
    userQuota.preCheckFile.mockRejectedValue(
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
