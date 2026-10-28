import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { Test } from '@nestjs/testing';
import {
  FastifyAdapter,
  type NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { randomUUID } from 'node:crypto';
import { configureApp } from '../bootstrap.js';
import { UploadController } from './upload.controller.js';
import { UploadService } from './upload.service.js';
import { ResumableUploadService } from './resumable-upload.service.js';
import { MessageService } from '../message/message.service.js';
import { BearerAuthService } from '../auth/bearer-auth.service.js';
import { MediaAccessService } from './media-access.service.js';
import { LinkPreviewService } from '../link-preview/link-preview.service.js';
import { FileSizeLimitError } from './file-size-limit.js';
import { DEFAULT_MAX_FILE_BYTES } from '../quota/quota-policy.js';
import { MEDIA_UPLOAD_CHUNK_BYTES } from '../../shared/media-upload-limits.js';

// Exercise the production parser registration and controller/DTO, not direct service calls.
describe('upload HTTP limits', () => {
  let app: NestFastifyApplication;
  let adapter: FastifyAdapter;
  const append = vi.fn(async (_user, _id, _range, body: Buffer) => ({
    offset: body.length,
  }));
  const init = vi.fn(async (_user, dto) => {
    FileSizeLimitError.assert(dto.totalBytes, DEFAULT_MAX_FILE_BYTES);
    return { totalBytes: dto.totalBytes };
  });

  beforeAll(async () => {
    const fixture = await Test.createTestingModule({
      controllers: [UploadController],
      providers: [
        { provide: UploadService, useValue: {} },
        { provide: MessageService, useValue: {} },
        { provide: ResumableUploadService, useValue: { append, init } },
        { provide: BearerAuthService, useValue: {} },
        { provide: MediaAccessService, useValue: {} },
        { provide: LinkPreviewService, useValue: {} },
      ],
    }).compile();
    adapter = new FastifyAdapter({ bodyLimit: 1024 * 1024 });
    adapter.getInstance().addHook('onRequest', async (request) => {
      // Authentication is outside this transport-limit test.
      request.user = { userId: 1 } as typeof request.user;
    });
    app = fixture.createNestApplication<NestFastifyApplication>(adapter);
    await configureApp(app, adapter);
    await app.init();
    await adapter.getInstance().ready();
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => {
    await app?.close();
  });

  it('accepts a complete 4 MiB binary chunk despite the 1 MiB global limit', async () => {
    const response = await adapter.getInstance().inject({
      method: 'PUT',
      url: `/api/v1/uploads/resumable/${randomUUID()}`,
      headers: {
        'content-type': 'application/octet-stream',
        'content-range': `bytes 0-${MEDIA_UPLOAD_CHUNK_BYTES - 1}/${MEDIA_UPLOAD_CHUNK_BYTES}`,
      },
      payload: Buffer.alloc(MEDIA_UPLOAD_CHUNK_BYTES),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.offset).toBe(MEDIA_UPLOAD_CHUNK_BYTES);
    expect(append).toHaveBeenCalledOnce();
  });

  it('rejects a binary chunk above 4 MiB before calling the handler', async () => {
    const response = await adapter.getInstance().inject({
      method: 'PUT',
      url: `/api/v1/uploads/resumable/${randomUUID()}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(MEDIA_UPLOAD_CHUNK_BYTES + 1),
    });
    expect(response.statusCode).toBe(413);
    expect(append).not.toHaveBeenCalled();
  });

  it('keeps the global JSON ceiling at 1 MiB', async () => {
    const response = await adapter.getInstance().inject({
      method: 'POST',
      url: '/api/v1/uploads/resumable/init',
      payload: { value: 'x'.repeat(1024 * 1024) },
    });
    expect(response.statusCode).toBe(413);
    expect(init).not.toHaveBeenCalled();
  });

  it.each(['IMAGE', 'VIDEO', 'AUDIO', 'FILE'])(
    'applies the configurable 1 GiB inclusive boundary to %s without allocating a whole file',
    async (intent) => {
      const dto = {
        clientMessageId: randomUUID(),
        partId: randomUUID(),
        position: 0,
        intent,
        originalName: 'attachment.bin',
        mimeType: 'application/octet-stream',
        totalBytes: DEFAULT_MAX_FILE_BYTES,
      };
      const accepted = await adapter.getInstance().inject({
        method: 'POST',
        url: '/api/v1/uploads/resumable/init',
        payload: dto,
      });
      expect(accepted.json().code).toBe(0);
      expect(init).toHaveBeenCalledOnce();
      init.mockClear();
      const rejected = await adapter.getInstance().inject({
        method: 'POST',
        url: '/api/v1/uploads/resumable/init',
        payload: { ...dto, totalBytes: DEFAULT_MAX_FILE_BYTES + 1 },
      });
      expect(rejected.json().code).toBe(10027);
      expect(init).toHaveBeenCalledOnce();
    },
  );
});
