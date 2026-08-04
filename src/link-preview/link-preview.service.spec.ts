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
      .mockResolvedValueOnce({ url: '/uploads/msg-assets/aa/aa/' + 'a'.repeat(64) })
      .mockResolvedValueOnce({ url: '/uploads/msg-assets/bb/bb/' + 'b'.repeat(64) });
    const service = serviceWith(
      {
        fetchHtml: vi.fn().mockResolvedValue({
          body: '<html>',
          finalUrl: 'https://example.com/',
        }),
        fetchImage: vi.fn().mockResolvedValue({ buf: Buffer.from('not-used') }),
      },
      { image: 'https://example.com/image', favicon: 'https://example.com/icon' },
      saveGeneratedWebp,
    );
    vi.spyOn(service as never, 'thumbnail').mockResolvedValue(Buffer.from('webp'));

    const card = await service.buildCardContent('https://example.com');

    expect(card.image).toContain('/uploads/msg-assets/');
    expect(card.favicon).toContain('/uploads/msg-assets/');
    expect(saveGeneratedWebp).toHaveBeenCalledTimes(2);
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
});
