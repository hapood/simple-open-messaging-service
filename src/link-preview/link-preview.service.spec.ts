import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LinkPreviewService } from './link-preview.service.js';

/**
 * The wire conversion pair is the heart of the digest/base64 split: the DB stores the image as a sha256
 * digest; the wire (frontend + federation outbound) inlines it as base64; the federation receiver decodes
 * it back. These pin that contract + its edge cases (non-LINK pass-through, missing-file degradation,
 * non-digest/non-data-URI pass-through) — the e2e only covers it indirectly.
 */
describe('LinkPreviewService wire conversion', () => {
  const svc = new LinkPreviewService({} as never, {} as never);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('enrichForWire (digest → base64, outbound)', () => {
    it('passes non-LINK content through unchanged', async () => {
      expect(await svc.enrichForWire('PURE_TEXT', 'hello')).toBe('hello');
      expect(await svc.enrichForWire('IMAGE', '{"url":"/uploads/x"}')).toBe('{"url":"/uploads/x"}');
    });

    it('passes a LINK card with no image through unchanged', async () => {
      const c = JSON.stringify({ url: 'https://x.com', title: 'T' });
      expect(await svc.enrichForWire('LINK', c)).toBe(c);
    });

    it('passes a LINK card whose image is NOT a digest (e.g. already base64) through unchanged', async () => {
      // The wire form should never be stored, but if it arrives here it is left as-is (no double work).
      const c = JSON.stringify({ url: 'https://x.com', image: 'data:image/webp;base64,AAAA' });
      expect(await svc.enrichForWire('LINK', c)).toBe(c);
    });

    it('replaces the digest with an inlined base64 data URI', async () => {
      const digest = 'a'.repeat(64);
      vi.spyOn(svc, 'readAsBase64').mockResolvedValue('data:image/webp;base64,AAAA');
      const out = await svc.enrichForWire('LINK', JSON.stringify({ url: 'https://x.com', title: 'T', image: digest }));
      expect(JSON.parse(out)).toEqual({ url: 'https://x.com', title: 'T', image: 'data:image/webp;base64,AAAA' });
    });

    it('drops the image field when the thumbnail file is missing (degrade to no-thumbnail)', async () => {
      const digest = 'a'.repeat(64);
      vi.spyOn(svc, 'readAsBase64').mockResolvedValue(undefined);
      const out = await svc.enrichForWire('LINK', JSON.stringify({ url: 'https://x.com', title: 'T', image: digest }));
      expect(JSON.parse(out)).toEqual({ url: 'https://x.com', title: 'T' });
    });

    it('passes malformed JSON through unchanged (never throws)', async () => {
      expect(await svc.enrichForWire('LINK', 'not json')).toBe('not json');
    });
  });

  describe('decodeFromWire (base64 → digest, federation receiver)', () => {
    it('passes non-LINK content through unchanged', async () => {
      expect(await svc.decodeFromWire('PURE_TEXT', 'hi')).toBe('hi');
    });

    it('passes a LINK card whose image is already a digest through unchanged', async () => {
      const digest = 'a'.repeat(64);
      const c = JSON.stringify({ url: 'https://x.com', image: digest });
      expect(await svc.decodeFromWire('LINK', c)).toBe(c);
    });

    it('turns an inlined base64 image into a digest', async () => {
      vi.spyOn(svc, 'ingestInlineImage').mockResolvedValue('b'.repeat(64));
      const out = await svc.decodeFromWire('LINK', JSON.stringify({ url: 'https://x.com', image: 'data:image/webp;base64,AAAA' }));
      expect(JSON.parse(out)).toEqual({ url: 'https://x.com', image: 'b'.repeat(64) });
    });

    it('drops the image when the data URI is malformed (decode failed)', async () => {
      vi.spyOn(svc, 'ingestInlineImage').mockResolvedValue(undefined);
      const out = await svc.decodeFromWire('LINK', JSON.stringify({ url: 'https://x.com', title: 'T', image: 'data:image/webp;base64,AAAA' }));
      expect(JSON.parse(out)).toEqual({ url: 'https://x.com', title: 'T' });
    });
  });
});
