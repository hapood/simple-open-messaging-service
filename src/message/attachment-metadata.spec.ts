import { describe, expect, it } from 'vitest';
import { hydrateAttachmentMetadata } from './attachment-metadata.js';

describe('attachment response metadata', () => {
  it('hydrates originals without changing the stored source or quote content', () => {
    const digest = 'a'.repeat(64);
    const original = JSON.stringify({
      url: `/uploads/msg-assets/aa/aa/${digest}`,
      name: 'photo',
      size: 42,
      quote: { text: 'keep' },
    });
    const meta = {
      mimeType: 'image/png',
      kind: 'IMAGE' as const,
      width: 20,
      height: 10,
      thumbnail: {
        digest: 'b'.repeat(64),
        size: 12,
        mimeType: 'image/webp' as const,
        width: 20,
        height: 10,
      },
    };
    const result = JSON.parse(
      hydrateAttachmentMetadata(
        original,
        new Map([[digest, { meta, bytes: 42n }]]),
      ),
    );
    expect(result.meta.thumbnail).toEqual(meta.thumbnail);
    expect(result.mimeType).toBe('image/png');
    expect(result.quote).toEqual({ text: 'keep' });
    expect(JSON.parse(original)).not.toHaveProperty('meta');
  });
});
