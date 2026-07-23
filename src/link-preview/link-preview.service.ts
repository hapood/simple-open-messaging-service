import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LinkContent } from '../upload/file-content.js';
import { SafeFetchService } from './safe-fetch.service.js';
import { OpenGraphService } from './open-graph.service.js';

/**
 * Orchestrates LINK card construction for a URL: SSRF-safe HTML fetch → OpenGraph parse → og:image
 * downscaled to a small square thumbnail + inlined as a base64 data URI → assemble the stored content.
 * The thumbnail rides INSIDE the content (not CAS), so a federated receiver renders it verbatim with no
 * cross-server localization. The result is server-authoritative — the client supplies only the URL, so a
 * sender can never forge the title/description/thumbnail.
 *
 * Never throws: every failure (blocked fetch, non-HTML, decode bomb) degrades to a bare-link card
 * `{ url }` so the message send always succeeds. Results are memoized in a bounded LRU so a repeatedly-
 * shared URL (and the send path + the live-preview endpoint) hit the cache instead of re-fetching +
 * re-exposing the server's egress IP.
 */
@Injectable()
export class LinkPreviewService {
  private readonly logger = new Logger(LinkPreviewService.name);
  private readonly cache = new Map<string, { card: LinkContent; expires: number }>();

  constructor(
    private readonly safeFetch: SafeFetchService,
    private readonly og: OpenGraphService,
  ) {}

  async buildCardContent(rawUrl: string): Promise<LinkContent> {
    const key = this.normalizeUrl(rawUrl);
    const hit = this.cacheGet(key);
    if (hit) return hit;

    let card: LinkContent;
    try {
      const html = await this.safeFetch.fetchHtml(rawUrl);
      if (!html) {
        card = { url: rawUrl };
        this.cacheSet(key, card, ERROR_TTL);
        return card;
      }
      const meta = this.og.parse(html.body, html.finalUrl);
      card = {
        url: html.finalUrl,
        title: meta.title,
        description: meta.description,
        siteName: meta.siteName,
        image: await this.inlineImage(meta.image),
      };
      this.cacheSet(key, card);
      return card;
    } catch (e) {
      this.logger.debug(
        `link-preview failed for ${rawUrl}: ${(e as Error).message}`,
      );
      card = { url: rawUrl };
      this.cacheSet(key, card, ERROR_TTL);
      return card;
    }
  }

  /** Download + downscale an og:image into a small square webp thumbnail, returned as a base64 data URI.
   *  Best-effort: undefined on any failure (blocked, non-image, decode bomb). Inlining (not CAS) means the
   *  thumbnail rides inside the content — a federated receiver renders it verbatim with no cross-server
   *  localization, and it renders under Tauri's CSP (`img-src ... data:`). */
  private async inlineImage(
    imageUrl: string | undefined,
  ): Promise<string | undefined> {
    if (!imageUrl) return undefined;
    const img = await this.safeFetch.fetchImage(imageUrl);
    if (!img) return undefined;
    try {
      const thumb = await this.thumbnail(img.buf);
      return `data:image/webp;base64,${thumb.toString('base64')}`;
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

const THUMB_PX = 96; // small square thumbnail (WeChat/Telegram-style), inlined as base64
const MAX_SRC_PIXELS = 4000 * 4000; // source-decode cap (decompression-bomb guard)
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h for a successfully-built card
const ERROR_TTL = 60 * 60 * 1000; // 1h for a bare/error card (retry the fetch sooner)
const CACHE_MAX = 512;
