import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import type { LinkContent } from '../upload/file-content.js';
import { UploadService } from '../upload/upload.service.js';
import { SafeFetchService } from './safe-fetch.service.js';
import { OpenGraphService } from './open-graph.service.js';

/**
 * Orchestrates LINK card construction for a URL: SSRF-safe HTML fetch → OpenGraph parse → og:image
 * downscaled to a small WebP thumbnail → shared message CAS → assemble the stored content. The result is
 * server-authoritative — the client supplies only the URL, so a sender cannot forge the metadata/assets.
 *
 * A page-fetch failure rejects generation. Optional image/favicon failures merely omit those fields;
 * absent metadata becomes required empty strings. Results are memoized in a bounded LRU so a repeatedly-
 * shared URL (and the send path + the live-preview endpoint) hit the cache instead of re-fetching +
 * re-exposing the server's egress IP.
 */
@Injectable()
export class LinkPreviewService {
  private readonly logger = new Logger(LinkPreviewService.name);
  private readonly cache = new Map<
    string,
    { card: LinkContent; expires: number }
  >();

  constructor(
    private readonly safeFetch: SafeFetchService,
    private readonly og: OpenGraphService,
    private readonly uploads: UploadService,
  ) {}

  async buildCardContent(
    rawUrl: string,
    fallbackText = '',
  ): Promise<LinkContent> {
    const key = `${this.normalizeUrl(rawUrl)}\u0000${this.descriptionFallback(fallbackText, rawUrl)}`;
    const hit = this.cacheGet(key);
    if (hit) return hit;

    try {
      const html = await this.safeFetch.fetchHtml(rawUrl);
      if (!html) {
        throw new LinkPreviewGenerationError('page could not be fetched');
      }
      const meta = this.og.parse(html.body, html.finalUrl);
      const card: LinkContent = {
        url: html.finalUrl,
        title: meta.title ?? '',
        description:
          meta.description ?? this.descriptionFallback(fallbackText, rawUrl),
        image: await this.localizeImage(meta.image),
        favicon: await this.localizeImage(meta.favicon),
      };
      this.cacheSet(key, card);
      return card;
    } catch (e) {
      this.logger.debug(
        `link-preview failed for ${rawUrl}: ${(e as Error).message}`,
      );
      if (e instanceof LinkPreviewGenerationError) throw e;
      throw new LinkPreviewGenerationError('link card generation failed', {
        cause: e,
      });
    }
  }

  private descriptionFallback(text: string, targetUrl: string): string {
    const withoutUrl = text.split(targetUrl).join(' ');
    const normalized = withoutUrl.replace(/\s+/g, ' ').trim();
    return normalized.slice(0, MAX_DESC_LEN);
  }

  /** Download, normalize and store an optional card asset in the shared message CAS. */
  private async localizeImage(
    imageUrl: string | undefined,
  ): Promise<string | undefined> {
    if (!imageUrl) return undefined;
    const img = await this.safeFetch.fetchImage(imageUrl);
    if (!img) return undefined;
    try {
      const thumb = await this.thumbnail(img.buf);
      return (await this.uploads.saveGeneratedWebp(thumb)).url;
    } catch {
      return undefined; // non-image, decompression bomb, or sharp failure
    }
  }

  /** og:image → small square thumbnail: EXIF-orient + cover-crop to THUMB_PX + webp. A pixel cap on the
   *  SOURCE decode defuses decompression bombs (a tiny file expanding into a huge canvas). Mirrors the
   *  avatar pipeline's rotate+resize+webp + pixel-cap shape. */
  private async thumbnail(buf: Buffer): Promise<Buffer> {
    const meta = await sharp(buf).metadata();
    if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_SRC_PIXELS) {
      throw new Error('og:image too large in pixels');
    }
    return sharp(buf)
      .rotate()
      .resize(THUMB_PX, THUMB_PX, { fit: 'cover', position: 'center' })
      .webp({ quality: 85 })
      .toBuffer();
  }

  /** Canonical cache key: drop fragment, lowercase host, strip default port, sort query, drop trailing
   *  slash. Query is kept (many sites key content on it) but ordered so equivalent URLs collide. */
  private normalizeUrl(rawUrl: string): string {
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return rawUrl;
    }
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if (
      (u.protocol === 'http:' && u.port === '80') ||
      (u.protocol === 'https:' && u.port === '443')
    ) {
      u.port = '';
    }
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  }

  private cacheGet(key: string): LinkContent | undefined {
    const e = this.cache.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    // LRU refresh: re-insert at the tail (Map preserves insertion order).
    this.cache.delete(key);
    this.cache.set(key, e);
    return e.card;
  }

  private cacheSet(key: string, card: LinkContent, ttlMs = CACHE_TTL): void {
    this.cache.set(key, { card, expires: Date.now() + ttlMs });
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

const THUMB_PX = 96;
const MAX_SRC_PIXELS = 4000 * 4000; // source-decode cap (decompression-bomb guard)

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h for a successfully-built card
const CACHE_MAX = 512;
const MAX_DESC_LEN = 500;

export class LinkPreviewGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LinkPreviewGenerationError';
  }
}
