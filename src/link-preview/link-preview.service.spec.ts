import { describe, expect, it, vi } from 'vitest';
import {
  LinkPreviewGenerationError,
  LinkPreviewService,
} from './link-preview.service.js';

function serviceWith(
  safeFetch: Record<string, unknown>,
  meta: Record<string, unknown>,
  saveGeneratedWebp = vi.fn(),
): LinkPreviewService {
  return new LinkPreviewService(
    safeFetch as never,
    { parse: vi.fn().mockReturnValue(meta) } as never,
    { saveGeneratedWebp } as never,
    {
      metadataSelectionsForUrl: vi
        .fn()
        .mockResolvedValue({ image: 'first', description: 'first' }),
    } as never,
  );
}

describe('LinkPreviewService card generation', () => {
  it('uses page metadata and ignores surrounding text when description exists', async () => {
    const service = serviceWith(
      {
        fetchHtml: vi.fn().mockResolvedValue({
          body: '<html>',
          finalUrl: 'https://example.com/final',
        }),
        fetchImage: vi.fn().mockResolvedValue(null),
      },
      { title: 'Page', description: 'Meta description' },
    );
    await expect(
      service.buildCardContent(
        'https://example.com/start',
        'shared words https://example.com/start',
      ),
    ).resolves.toEqual({
      url: 'https://example.com/final',
      title: 'Page',
      description: 'Meta description',
      image: undefined,
      favicon: undefined,
    });
  });

  it('stores image and favicon in the shared CAS and returns their URLs', async () => {
    const saveGeneratedWebp = vi
      .fn()
      .mockResolvedValueOnce({
        url: '/uploads/msg-assets/aa/aa/' + 'a'.repeat(64),
      })
      .mockResolvedValueOnce({
        url: '/uploads/msg-assets/bb/bb/' + 'b'.repeat(64),
      });
    const service = serviceWith(
      {
        fetchHtml: vi.fn().mockResolvedValue({
          body: '<html>',
          finalUrl: 'https://example.com/',
        }),
        fetchImage: vi.fn().mockResolvedValue({ buf: Buffer.from('not-used') }),
      },
      {
        image: 'https://example.com/image',
        favicon: 'https://example.com/icon',
      },
      saveGeneratedWebp,
    );
    vi.spyOn(service as never, 'thumbnail').mockResolvedValue(
      Buffer.from('webp'),
    );

    const card = await service.buildCardContent('https://example.com');

    expect(card.image).toContain('/uploads/msg-assets/');
    expect(card.favicon).toContain('/uploads/msg-assets/');
    expect(saveGeneratedWebp).toHaveBeenCalledTimes(2);
  });

  it('logs the optional asset type and failure stage without failing the card', async () => {
    const service = serviceWith(
      {
        fetchHtml: vi.fn().mockResolvedValue({
          body: '<html>',
          finalUrl: 'https://example.com/',
        }),
        fetchImage: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce({ buf: Buffer.from('broken') }),
      },
      {
        image: 'https://cdn.example.com/cover.jpg?token=secret',
        favicon: 'https://static.example.com/favicon.ico',
      },
    );
    vi.spyOn(service as never, 'thumbnail').mockRejectedValue(
      new Error('unsupported image'),
    );
    const warn = vi.spyOn(
      (service as unknown as { logger: { warn: (message: string) => void } })
        .logger,
      'warn',
    );

    await expect(
      service.buildCardContent('https://example.com'),
    ).resolves.toMatchObject({ image: undefined, favicon: undefined });
    expect(warn).toHaveBeenCalledWith(
      'link-preview optional asset omitted asset=image stage=fetch host=cdn.example.com',
    );
    expect(warn).toHaveBeenCalledWith(
      'link-preview optional asset omitted asset=favicon stage=decode host=static.example.com format=unknown contentType=unknown bytes=6 reason=unsupported image',
    );
    expect(warn.mock.calls.flat().join(' ')).not.toContain('token=secret');
  });

  it('logs CAS failures separately for optional assets', async () => {
    const service = serviceWith(
      {
        fetchHtml: vi.fn().mockResolvedValue({
          body: '<html>',
          finalUrl: 'https://example.com/',
        }),
        fetchImage: vi.fn().mockResolvedValue({ buf: Buffer.from('image') }),
      },
      { favicon: 'https://example.com/favicon.ico' },
      vi.fn().mockRejectedValue(new Error('disk unavailable')),
    );
    vi.spyOn(service as never, 'thumbnail').mockResolvedValue(
      Buffer.from('webp'),
    );
    const warn = vi.spyOn(
      (service as unknown as { logger: { warn: (message: string) => void } })
        .logger,
      'warn',
    );

    await expect(
      service.buildCardContent('https://example.com'),
    ).resolves.toMatchObject({ favicon: undefined });
    expect(warn).toHaveBeenCalledWith(
      'link-preview optional asset omitted asset=favicon stage=cas host=example.com reason=disk unavailable',
    );
  });

  it('decodes a traditional BMP/DIB ICO favicon before converting it to WebP', async () => {
    const saveGeneratedWebp = vi.fn().mockResolvedValue({
      url: '/uploads/msg-assets/aa/aa/' + 'a'.repeat(64),
    });
    const service = serviceWith(
      {
        fetchHtml: vi.fn().mockResolvedValue({
          body: '<html>',
          finalUrl: 'https://example.com/',
        }),
        fetchImage: vi.fn().mockResolvedValue({
          buf: dibIco(),
          contentType: 'image/x-icon',
        }),
      },
      { favicon: 'https://example.com/favicon.ico' },
      saveGeneratedWebp,
    );

    await expect(
      service.buildCardContent('https://example.com'),
    ).resolves.toMatchObject({
      favicon: '/uploads/msg-assets/aa/aa/' + 'a'.repeat(64),
    });
    const saved = saveGeneratedWebp.mock.calls[0][0] as Buffer;
    await expect(
      import('sharp').then(({ default: sharp }) => sharp(saved).metadata()),
    ).resolves.toMatchObject({ format: 'webp', width: 96, height: 96 });
  });

  it('fills only description from normalized user text and keeps title required', async () => {
    const service = serviceWith(
      {
        fetchHtml: vi.fn().mockResolvedValue({
          body: '<html>',
          finalUrl: 'https://example.com/',
        }),
        fetchImage: vi.fn().mockResolvedValue(null),
      },
      {},
    );
    await expect(
      service.buildCardContent(
        'https://example.com',
        '  hello\n https://example.com   world  ',
      ),
    ).resolves.toMatchObject({ title: '', description: 'hello world' });
  });

  it('reports an unfetchable page as generation failure', async () => {
    const service = serviceWith(
      { fetchHtml: vi.fn().mockResolvedValue(null) },
      {},
    );
    await expect(
      service.buildCardContent('https://example.com'),
    ).rejects.toBeInstanceOf(LinkPreviewGenerationError);
  });

  it('keeps an async generation private and grants its owner temporary CAS access', async () => {
    const digest = 'a'.repeat(64);
    const service = serviceWith(
      {
        fetchHtml: vi.fn().mockResolvedValue({
          body: '<html>',
          finalUrl: 'https://example.com/',
        }),
        fetchImage: vi.fn().mockResolvedValue({ buf: Buffer.from('image') }),
      },
      { image: 'https://example.com/image' },
      vi.fn().mockResolvedValue({
        url: `/uploads/msg-assets/aa/aa/${digest}`,
      }),
    );
    vi.spyOn(service as never, 'thumbnail').mockResolvedValue(
      Buffer.from('webp'),
    );

    const started = service.startGeneration(7, 'https://example.com');
    expect(service.getGeneration(7, started.generationId)?.status).toBe(
      'pending',
    );
    expect(service.getGeneration(8, started.generationId)).toBeUndefined();

    await vi.waitFor(() => {
      expect(service.getGeneration(7, started.generationId)?.status).toBe(
        'succeeded',
      );
    });
    const result = service.getGeneration(7, started.generationId);
    expect(result?.content?.image).toBe(
      `/uploads/msg-assets/aa/aa/${digest}?generationId=${started.generationId}`,
    );
    expect(
      service.canReadGenerationAsset(7, started.generationId, digest),
    ).toBe(true);
    expect(
      service.canReadGenerationAsset(8, started.generationId, digest),
    ).toBe(false);
    expect(service.consumeGeneration(7, started.generationId)?.image).toBe(
      `/uploads/msg-assets/aa/aa/${digest}`,
    );
  });

  it('exposes only a failed state when generation cannot fetch the page', async () => {
    const service = serviceWith(
      { fetchHtml: vi.fn().mockResolvedValue(null) },
      {},
    );
    const started = service.startGeneration(7, 'https://example.com');

    await vi.waitFor(() => {
      expect(service.getGeneration(7, started.generationId)?.status).toBe(
        'failed',
      );
    });
    expect(
      service.getGeneration(7, started.generationId)?.content,
    ).toBeUndefined();
    expect(service.consumeGeneration(7, started.generationId)).toBeUndefined();
  });

  it('lets the backend reuse a live task or replace a failed task on retry', async () => {
    let resolveHtml!: (value: { body: string; finalUrl: string }) => void;
    const pendingHtml = new Promise<{ body: string; finalUrl: string }>(
      (resolve) => {
        resolveHtml = resolve;
      },
    );
    const service = serviceWith(
      {
        fetchHtml: vi
          .fn()
          .mockReturnValueOnce(pendingHtml)
          .mockResolvedValueOnce(null)
          .mockReturnValueOnce(pendingHtml),
        fetchImage: vi.fn().mockResolvedValue(null),
      },
      {},
    );

    const pending = service.startGeneration(7, 'https://example.com');
    const reused = service.startGeneration(
      7,
      'https://example.com',
      '',
      pending.generationId,
    );
    expect(reused.generationId).toBe(pending.generationId);

    const failed = service.startGeneration(7, 'https://failed.example.com');
    await vi.waitFor(() => {
      expect(service.getGeneration(7, failed.generationId)?.status).toBe(
        'failed',
      );
    });
    const replaced = service.startGeneration(
      7,
      'https://failed.example.com',
      '',
      failed.generationId,
    );
    expect(replaced.generationId).not.toBe(failed.generationId);
    expect(replaced.status).toBe('pending');

    resolveHtml({ body: '<html>', finalUrl: 'https://example.com' });
  });
});

/** Minimal 1x1, 32-bit ICO whose image payload is a traditional DIB rather than PNG. */
function dibIco(): Buffer {
  const result = Buffer.alloc(70);
  result.writeUInt16LE(0, 0);
  result.writeUInt16LE(1, 2);
  result.writeUInt16LE(1, 4);
  result[6] = 1;
  result[7] = 1;
  result.writeUInt16LE(1, 10);
  result.writeUInt16LE(32, 12);
  result.writeUInt32LE(48, 14);
  result.writeUInt32LE(22, 18);
  result.writeUInt32LE(40, 22);
  result.writeInt32LE(1, 26);
  result.writeInt32LE(2, 30);
  result.writeUInt16LE(1, 34);
  result.writeUInt16LE(32, 36);
  result.writeUInt32LE(4, 42);
  result.set([0x20, 0x80, 0xff, 0xff], 62);
  return result;
}
