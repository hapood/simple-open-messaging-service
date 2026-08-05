import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { decodeIco, isIco, type DecodeImage } from 'icojs';
import sharp from 'sharp';
import type { LinkContent } from '../upload/file-content.js';
import { UploadService } from '../upload/upload.service.js';
import { SafeFetchService } from './safe-fetch.service.js';
import { OpenGraphService } from './open-graph.service.js';
import { LinkCardRuleService } from './link-card-rule.service.js';

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
export class LinkPreviewService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LinkPreviewService.name);
  private readonly cache = new Map<
    string,
    { card: LinkContent; expires: number }
  >();
  private readonly generations = new Map<string, LinkCardGeneration>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  constructor(
    private readonly safeFetch: SafeFetchService,
    private readonly og: OpenGraphService,
    private readonly uploads: UploadService,
    private readonly rules: LinkCardRuleService,
  ) {}

  onModuleInit(): void {
    this.cleanupTimer = setInterval(
      () => this.deleteExpiredGenerations(),
      GENERATION_SWEEP_MS,
    );
    this.cleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
  }

  startGeneration(
    userId: number,
    rawUrl: string,
    fallbackText = '',
    requestedGenerationId?: string,
  ): LinkCardGenerationResult {
    if (requestedGenerationId) {
      const existing = this.getOwnedGeneration(userId, requestedGenerationId);
      if (existing && existing.status !== 'failed') {
        return this.generationResult(existing);
      }
      if (existing) this.generations.delete(existing.id);
    }
    const id = randomUUID();
    const now = Date.now();
    const expiresAt = now + GENERATION_TTL_MS;
    this.generations.set(id, {
      id,
      userId,
      status: 'pending',
      assetDigests: [],
      createdAt: now,
      expiresAt,
    });
    void this.runGeneration(id, rawUrl, fallbackText);
    return { generationId: id, status: 'pending', expiresAt };
  }

  getGeneration(
    userId: number,
    id: string,
  ): LinkCardGenerationResult | undefined {
    const generation = this.getOwnedGeneration(userId, id);
    if (!generation) return undefined;
    return this.generationResult(generation);
  }

  private generationResult(
    generation: LinkCardGeneration,
  ): LinkCardGenerationResult {
    return {
      generationId: generation.id,
      status: generation.status,
      expiresAt: generation.expiresAt,
      ...(generation.content
        ? { content: this.previewContent(generation.content, generation.id) }
        : {}),
    };
  }

  consumeGeneration(userId: number, id: string): LinkContent | undefined {
    const generation = this.getOwnedGeneration(userId, id);
    return generation?.status === 'succeeded' ? generation.content : undefined;
  }

  finishGeneration(userId: number, id: string): void {
    const generation = this.generations.get(id);
    if (generation?.userId === userId) this.generations.delete(id);
  }

  canReadGenerationAsset(userId: number, id: string, digest: string): boolean {
    const generation = this.getOwnedGeneration(userId, id);
    return Boolean(
      generation?.status === 'succeeded' &&
        generation.assetDigests.includes(digest),
    );
  }

  private async runGeneration(
    id: string,
    rawUrl: string,
    fallbackText: string,
  ): Promise<void> {
    try {
      const content = await this.buildCardContent(rawUrl, fallbackText);
      const generation = this.generations.get(id);
      if (!generation) return;
      generation.content = content;
      generation.assetDigests = extractCardAssetDigests(content);
      generation.status = 'succeeded';
    } catch {
      const generation = this.generations.get(id);
      if (generation) generation.status = 'failed';
    }
  }

  private getOwnedGeneration(
    userId: number,
    id: string,
  ): LinkCardGeneration | undefined {
    const generation = this.generations.get(id);
    if (!generation || generation.userId !== userId) return undefined;
    if (generation.expiresAt <= Date.now()) {
      this.generations.delete(id);
      return undefined;
    }
    return generation;
  }

  private previewContent(
    content: LinkContent,
    generationId: string,
  ): LinkContent {
    const authorize = (url: string | undefined) =>
      url
        ? `${url}?generationId=${encodeURIComponent(generationId)}`
        : undefined;
    return {
      ...content,
      image: authorize(content.image),
      favicon: authorize(content.favicon),
    };
  }

  private deleteExpiredGenerations(): void {
    const now = Date.now();
    for (const [id, generation] of this.generations) {
      if (generation.expiresAt <= now) this.generations.delete(id);
    }
  }

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
      const selections = await this.rules.metadataSelectionsForUrl(
        html.finalUrl,
      );
      const meta = this.og.parse(
        html.body,
        html.finalUrl,
        selections.image,
        selections.description,
      );
      const card: LinkContent = {
        url: html.finalUrl,
        title: meta.title ?? '',
        description:
          meta.description ?? this.descriptionFallback(fallbackText, rawUrl),
        siteName: meta.siteName,
        image: await this.localizeImage(meta.image, 'image'),
        favicon: await this.localizeImage(meta.favicon, 'favicon'),
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
    asset: 'image' | 'favicon',
  ): Promise<string | undefined> {
    if (!imageUrl) return undefined;
    const img = await this.safeFetch.fetchImage(imageUrl);
    if (!img) {
      this.logger.warn(
        `link-preview optional asset omitted asset=${asset} stage=fetch host=${safeAssetHost(imageUrl)}`,
      );
      return undefined;
    }

    let thumb: Buffer;
    try {
      thumb = await this.thumbnail(img.buf, asset);
    } catch (error) {
      this.logger.warn(
        `link-preview optional asset omitted asset=${asset} stage=decode host=${safeAssetHost(imageUrl)} format=${assetFormat(img.buf)} contentType=${img.contentType ?? 'unknown'} bytes=${img.buf.length} reason=${assetErrorMessage(error)}`,
      );
      return undefined;
    }

    try {
      return (await this.uploads.saveGeneratedWebp(thumb)).url;
    } catch (error) {
      this.logger.warn(
        `link-preview optional asset omitted asset=${asset} stage=cas host=${safeAssetHost(imageUrl)} reason=${assetErrorMessage(error)}`,
      );
      return undefined;
    }
  }

  /** og:image → small square thumbnail: EXIF-orient + cover-crop to THUMB_PX + webp. A pixel cap on the
   *  SOURCE decode defuses decompression bombs (a tiny file expanding into a huge canvas). Mirrors the
   *  avatar pipeline's rotate+resize+webp + pixel-cap shape. */
  private async thumbnail(
    buf: Buffer,
    asset: 'image' | 'favicon' = 'image',
  ): Promise<Buffer> {
    const source =
      asset === 'favicon' && isIco(buf)
        ? Buffer.from(this.selectIcoFrame(await decodeIco(buf)).buffer)
        : buf;
    const meta = await sharp(source).metadata();
    if ((meta.width ?? 0) * (meta.height ?? 0) > MAX_SRC_PIXELS) {
      throw new Error('og:image too large in pixels');
    }
    return sharp(source)
      .rotate()
      .resize(THUMB_PX, THUMB_PX, { fit: 'cover', position: 'center' })
      .webp({ quality: 85 })
      .toBuffer();
  }

  private selectIcoFrame(frames: DecodeImage[]): DecodeImage {
    if (frames.length === 0) throw new Error('ICO contains no images');
    return frames.sort((left, right) => {
      const leftLargeEnough = left.width >= THUMB_PX && left.height >= THUMB_PX;
      const rightLargeEnough =
        right.width >= THUMB_PX && right.height >= THUMB_PX;
      if (leftLargeEnough !== rightLargeEnough) return leftLargeEnough ? -1 : 1;

      const leftArea = left.width * left.height;
      const rightArea = right.width * right.height;
      if (leftArea !== rightArea) {
        return leftLargeEnough ? leftArea - rightArea : rightArea - leftArea;
      }
      return right.bpp - left.bpp;
    })[0];
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
const GENERATION_TTL_MS = 5 * 60 * 1000;
const GENERATION_SWEEP_MS = 5 * 60 * 1000;

export type LinkCardGenerationStatus = 'pending' | 'succeeded' | 'failed';

interface LinkCardGeneration {
  id: string;
  userId: number;
  status: LinkCardGenerationStatus;
  content?: LinkContent;
  assetDigests: string[];
  createdAt: number;
  expiresAt: number;
}

export interface LinkCardGenerationResult {
  generationId: string;
  status: LinkCardGenerationStatus;
  expiresAt: number;
  content?: LinkContent;
}

function extractCardAssetDigests(content: LinkContent): string[] {
  return [content.image, content.favicon]
    .map(
      (url) =>
        url?.match(
          /\/uploads\/msg-assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})$/,
        )?.[1],
    )
    .filter((digest): digest is string => digest !== undefined);
}

function safeAssetHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname || 'unknown';
  } catch {
    return 'invalid';
  }
}

function assetErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function assetFormat(buf: Buffer): string {
  if (isIco(buf)) return 'ico';
  if (buf.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  return 'unknown';
}

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

export class LinkPreviewGenerationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LinkPreviewGenerationError';
  }
}
