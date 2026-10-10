import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ContentType } from '../database/enums.js';
import { UploadController } from './upload.controller.js';

const PAYLOAD = {
  digest: 'd'.repeat(64),
  url: '/uploads/msg-assets/dd/dd/' + 'd'.repeat(64),
  size: 9,
  family: 'IMAGE',
  w: 10,
  h: 20,
};

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
  ingestResult = { status: 'COMPLETED', result: PAYLOAD },
}: {
  clientMessageId?: string | undefined;
  intent?: ContentType | null;
  files?: Array<{ mimetype: string; buffer: Buffer; filename?: string }>;
  fields?: Record<string, string>;
  ingestResult?: { status: string; result?: typeof PAYLOAD };
} = {}) {
  const uploadService = {
    consumeParts: vi.fn().mockResolvedValue({ kind: 'ok', files, fields }),
  };
  const messageService = {
    getStagedIntent: vi.fn().mockResolvedValue(intent),
    failStaged: vi.fn().mockResolvedValue(undefined),
  };
  const resumable = {
    ingestBuffered: vi.fn().mockResolvedValue(ingestResult),
  };
  const controller = new UploadController(
    uploadService as never,
    messageService as never,
    resumable as never,
  );
  const req = {
    user: { userId: 7 },
    headers: clientMessageId ? { 'x-client-message-id': clientMessageId } : {},
  } as unknown as FastifyRequest;
  return { controller, uploadService, messageService, resumable, req };
}

describe('UploadController type-agnostic upload (batch-commit model)', () => {
  it('ingests each part onto the shared session state machine and returns its payload', async () => {
    const { controller, resumable, req } = setup();

    const result = await controller.upload(req);

    expect(result).toEqual(PAYLOAD);
    expect(resumable.ingestBuffered).toHaveBeenCalledWith(
      7,
      {
        clientMessageId: 'stage-1',
        partId: '11111111-1111-4111-8111-111111111111',
        position: 0,
        intent: 'IMAGE',
        originalName: 'a.png',
        mimeType: 'image/png',
      },
      Buffer.from('png bytes'),
    );
  });

  it('rejects without an x-client-message-id header', async () => {
    const { controller, req } = setup({ clientMessageId: '' });
    await expect(controller.upload(req)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
  });

  it('fails the stage when there is no pending send for the clientMessageId', async () => {
    const { controller, messageService, uploadService, resumable, req } =
      setup({ intent: null });
    await expect(controller.upload(req)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
    expect(messageService.failStaged).toHaveBeenCalledWith(
      7,
      'stage-1',
      'media send is not pending',
    );
    expect(resumable.ingestBuffered).not.toHaveBeenCalled();
    expect(uploadService.consumeParts).not.toHaveBeenCalled();
  });

  it('marks the stage failed when the ingest rejects with a business error (e.g. quota)', async () => {
    const { controller, messageService, resumable, req } = setup();
    resumable.ingestBuffered.mockRejectedValue(
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
  });

  it('marks the stage failed when media validation inside the ingest rejects the bytes', async () => {
    const { controller, messageService, resumable, req } = setup();
    resumable.ingestBuffered.mockRejectedValue(new Error('invalid video'));

    await expect(controller.upload(req)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });

    expect(messageService.failStaged).toHaveBeenCalledWith(
      7,
      'stage-1',
      'invalid video',
    );
  });

  it('rejects when the ingest yields no payload', async () => {
    const { controller, messageService, req } = setup({
      ingestResult: { status: 'COMPLETING' },
    });
    await expect(controller.upload(req)).rejects.toMatchObject({
      bizCode: BusinessCode.VALIDATION_FAILED,
    });
    expect(messageService.failStaged).toHaveBeenCalledWith(
      7,
      'stage-1',
      'upload produced no result',
    );
  });
});
