import { Injectable, Logger } from '@nestjs/common';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
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

  /** Download an og:image, downscale it to a small square webp thumbnail, persist it content-addressed,
   *  and return the thumbnail's sha256 DIGEST. The DB stores only the digest (small); the wire
   *  serializer inlines the bytes as base64 on read (see readAsBase64). Best-effort: undefined on any
   *  failure (blocked, non-image, decode bomb). */
  private async inlineImage(
    imageUrl: string | undefined,
  ): Promise<string | undefined> {
    if (!imageUrl) return undefined;
    const img = await this.safeFetch.fetchImage(imageUrl);
    if (!img) return undefined;
    try {
      const thumb = await this.thumbnail(img.buf);
      return await this.storeThumb(thumb);
    } catch {
      return undefined; // non-image, decompression bomb, or sharp failure
    }
  }

  /** Persist a thumbnail content-addressed (sha256 of the thumbnail bytes) and return its digest.
   *  Idempotent — an existing file is left as-is (dedup: the same image → the same thumbnail → the same
   *  digest → one file). Atomic (tmp + rename on the same filesystem). */
  private async storeThumb(buf: Buffer): Promise<string> {
    const digest = createHash('sha256').update(buf).digest('hex');
    const abs = join(THUMB_DIR, `${digest}.webp`);
    await this.writeThumb(abs, buf);
    return digest;
  }

  /** Read a stored thumbnail back as a base64 data URI. Used by the message wire serializer to inline
   *  the image into content.image for the frontend / a federated peer (the DB carries only the digest).
   *  Undefined when the file is missing → the card degrades to no-thumbnail on the wire. */
  async readAsBase64(digest: string): Promise<string | undefined> {
    const buf = await this.readThumb(join(THUMB_DIR, `${digest}.webp`));
    return buf ? `data:image/webp;base64,${buf.toString('base64')}` : undefined;
  }

  /** Decode a base64 data URI back to raw bytes + the sha256 digest, then persist it (the federation
   *  receiver path: the peer sent the image inlined, we store it content-addressed and keep only the
   *  digest in our DB). Returns the digest, or undefined if the data URI is malformed. */
  async ingestInlineImage(dataUri: string): Promise<string | undefined> {
    const buf = decodeDataUri(dataUri);
    if (!buf) return undefined;
    return this.storeThumb(buf);
  }

  /** Enrich a LINK message's STORED content for the wire: replace the image digest with an inlined
   *  base64 data URI read from disk (the DB keeps only the digest; the frontend / a federated peer need
   *  the bytes to render). A missing file drops the image field (degrade to no-thumbnail on the wire).
   *  Non-LINK or digest-less content passes through unchanged. */
  async enrichForWire(contentType: string, content: string): Promise<string> {
    if (contentType !== 'LINK' || !content) return content;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return content;
    }
    const image = obj['image'];
    if (typeof image !== 'string' || !DIGEST_RE.test(image)) return content;
    const b64 = await this.readAsBase64(image);
    if (!b64) {
      const { image: _drop, ...rest } = obj;
      return JSON.stringify(rest);
    }
    return JSON.stringify({ ...obj, image: b64 });
  }

  /** Receive a LINK message's WIRE content: replace an inlined base64 image with the stored digest
   *  (decode + persist content-addressed). The DB stores only the digest. A malformed data URI drops the
   *  image field. Non-LINK or non-inlined content passes through unchanged. */
  async decodeFromWire(contentType: string, content: string): Promise<string> {
    if (contentType !== 'LINK' || !content) return content;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(content) as Record<string, unknown>;
    } catch {
      return content;
    }
    const image = obj['image'];
    if (typeof image !== 'string' || !image.startsWith('data:')) return content;
    const digest = await this.ingestInlineImage(image);
    if (!digest) {
      const { image: _drop, ...rest } = obj;
      return JSON.stringify(rest);
    }
    return JSON.stringify({ ...obj, image: digest });
  }

  /** Read a thumbnail file, or undefined if missing (a missing digest just means first encounter). */
  private async readThumb(abs: string): Promise<Buffer | undefined> {
    try {
      return await readFile(abs);
    } catch {
      return undefined;
    }
  }

  /** Atomically write a thumbnail (tmp + rename). Skips the write when the file already exists (dedup);
   *  concurrent writers of the same digest produce byte-identical files regardless. */
  private async writeThumb(abs: string, buf: Buffer): Promise<void> {
    try {
      await access(abs);
      return; // already stored — dedup
    } catch {
      // not present — write below
    }
    await mkdir(THUMB_DIR, { recursive: true });
    const tmp = `${abs}.${process.pid}.${buf.length}.tmp`;
    await writeFile(tmp, buf);
    await rename(tmp, abs);
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

const THUMB_DIR = join(process.cwd(), 'data', 'link-thumbs'); // content-addressed og:image thumbnails (server-internal dedup cache; not HTTP-served — the image is inlined as base64 in the message content)
const THUMB_PX = 96; // small square thumbnail (WeChat/Telegram-style), inlined as base64
const MAX_SRC_PIXELS = 4000 * 4000; // source-decode cap (decompression-bomb guard)

/** Match a base64 image data URI (`data:image/<sub>;base64,<payload>`). Used to decode an inlined wire
 *  image back to bytes on the federation receiver (the peer sent it inlined; we store it + keep the
 *  digest). */
const DATA_URI_RE = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/]+=*)$/i;
/** A link thumbnail's content-addressed digest (sha256 hex, 64 chars) — the form stored in the DB. */
const DIGEST_RE = /^[0-9a-f]{64}$/;
function decodeDataUri(s: string): Buffer | undefined {
  const m = DATA_URI_RE.exec(s);
  if (!m) return undefined;
  try {
    return Buffer.from(m[1], 'base64');
  } catch {
    return undefined;
  }
}
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24h for a successfully-built card
const ERROR_TTL = 60 * 60 * 1000; // 1h for a bare/error card (retry the fetch sooner)
const CACHE_MAX = 512;
