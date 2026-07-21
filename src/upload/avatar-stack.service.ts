import { Injectable, Logger } from '@nestjs/common';
import { existsSync, readFile, writeFile, rename, mkdir } from 'fs';
import { join, dirname } from 'path';
import { createHash, randomBytes } from 'crypto';
import { promisify } from 'util';
import sharp from 'sharp';
import { UploadService } from './upload.service.js';

const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);
const renameAsync = promisify(rename);
const mkdirAsync = promisify(mkdir);

/**
 * Composites a "stacked avatar" PNG — N sender avatars drawn overlapping on a transparent canvas — served
 * as a notification's single `icon`. Every platform's notification icon slot accepts exactly ONE image
 * (Web `icon`, Android `setLargeIcon`, Tauri single icon) with no multi-layer layout, so the only way to
 * render a stack across all platforms is to pre-composite it into one bitmap. The server is the right place
 * to do that: it already has every sender's avatar on disk (flat multi-size webp), and compositing here
 * means the three clients (SW / Kotlin / foreground) each just fetch one URL — no triplicated canvas code
 * (the SW fetching + decoding N avatars would be especially heavy).
 *
 * Pipeline: one SVG (transparent canvas + N circular-clipped `<image>`s or initial-letter circles + white
 * rings) → sharp renders it to PNG → atomic tmp+rename into the cache. sharp's first `.composite()`-free
 * render path: the SVG itself carries the layout (circle clips, rings, initials), so a single
 * `sharp(svg).png()` produces the final image. librsvg (bundled in the prebuilt sharp linux-x64 binary)
 * renders the SVG; if it is ever unavailable the render throws and we degrade to `null` (the client falls
 * back to its app icon) — graceful, never a 500.
 *
 * Cache: keyed by the sorted `(userId, avatarUrl, displayName)` tuples (sort → order-independent), stored
 * at `data/uploads/notif-icons/<sha1>.png`. Served by the EXISTING `/uploads/*` static handler (no new
 * route), so it inherits the media_token-cookie auth gate + `Cache-Control: private, max-age=300`.
 * Invalidation is automatic: a user changing their avatar changes their `avatarUrl` → the key changes → a
 * fresh composite; no explicit purge.
 */
@Injectable()
export class AvatarStackService {
  private readonly logger = new Logger(AvatarStackService.name);

  /** Maximum senders drawn — beyond this the stack is illegible; the body's "+N" carries the rest. */
  static readonly MAX_TILES = 4;
  /** The on-disk namespace under data/uploads/ — served as /uploads/notif-icons/*. */
  static readonly DIR_REL = 'notif-icons';

  /** Canvas geometry (px). Square; large enough for Android `setLargeIcon` + browser `icon`. */
  private static readonly CANVAS = 128;
  /** Per-tile diameter (px). */
  private static readonly TILE = 56;
  /** White separator ring thickness (px) drawn around each circle. */
  private static readonly RING = 2;

  constructor(private readonly upload: UploadService) {}

  /**
   * Composite (or return the cached) stacked-avatar PNG for `inputs`. Returns its `/uploads/notif-icons/…`
   * URL, or `null` when there is nothing to draw or the render fails (caller → app-icon fallback). Cap
   * {@link MAX_TILES} senders; order within `inputs` does not matter (the cache key is sorted + the stack
   * is laid out left-to-right by the (sorted) input order).
   */
  async composeStackedAvatar(
    inputs: Array<{ avatarUrl: string; displayName: string; userId: number }>,
  ): Promise<string | null> {
    if (inputs.length === 0) return null;
    const tiles = inputs.slice(0, AvatarStackService.MAX_TILES);

    const key = this.cacheKey(tiles);
    const rel = join(AvatarStackService.DIR_REL, `${key}.png`);
    const abs = join(this.upload.uploadDir, rel);
    if (existsSync(abs)) return `/uploads/${rel}`; // cache hit — no sharp work

    try {
      const png = await this.renderStack(tiles);
      if (!png) return null;
      await mkdirAsync(dirname(abs), { recursive: true });
      // Atomic publish (same filesystem → rename is atomic). Concurrent composers of the same key write
      // byte-identical files; the second rename overwrites the first harmlessly.
      const tmp = `${abs}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
      await writeFileAsync(tmp, png);
      await renameAsync(tmp, abs);
      return `/uploads/${rel}`;
    } catch (e) {
      // Most likely cause: librsvg unavailable in this sharp build → SVG render threw. Degrade to null so
      // the client shows its app icon; never surface a push-path failure.
      this.logger.warn(`avatar-stack render failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** sha1 of the sorted `(userId, avatarUrl, displayName)` tuples — order-independent + stable. */
  private cacheKey(tiles: Array<{ avatarUrl: string; displayName: string; userId: number }>): string {
    const norm = tiles
      .map((t) => [t.userId, t.avatarUrl ?? '', (t.displayName ?? '').trim()] as const)
      .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]) || a[2].localeCompare(b[2]));
    return createHash('sha1').update(JSON.stringify(norm)).digest('hex');
  }

  /** Render the stacked-avatar SVG → PNG buffer. Null only if every tile failed to source (defensive). */
  private async renderStack(
    tiles: Array<{ avatarUrl: string; displayName: string; userId: number }>,
  ): Promise<Buffer | null> {
    const offsets = this.layout(tiles.length);
    const parts: string[] = [];
    for (let i = 0; i < tiles.length; i++) {
      parts.push(await this.tileSvg(tiles[i], offsets[i], i));
    }
    if (parts.length === 0) return null;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AvatarStackService.CANVAS}" height="${AvatarStackService.CANVAS}">${parts.join('')}</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  /** Center-x positions for `n` tiles, horizontally centered + overlapping (cap offset for a tidy stack). */
  private layout(n: number): number[] {
    const c = AvatarStackService.CANVAS;
    const d = AvatarStackService.TILE;
    const r = d / 2;
    if (n === 1) return [c / 2];
    // Offset between consecutive centers: fit the group, but cap so tiles always overlap (a real stack).
    const offset = Math.min((c - d) / (n - 1), d * 0.55);
    const groupWidth = d + offset * (n - 1);
    const startX = (c - groupWidth) / 2 + r;
    return Array.from({ length: n }, (_, i) => startX + offset * i);
  }

  /** One tile's SVG fragment at center-x `cx`: a white ring + either the avatar (circular-clipped) or an
   *  initial-letter colored circle (when the sender has no avatar / the file can't be read). */
  private async tileSvg(
    tile: { avatarUrl: string; displayName: string; userId: number },
    cx: number,
    i: number,
  ): Promise<string> {
    const cy = AvatarStackService.CANVAS / 2;
    const r = AvatarStackService.TILE / 2;
    const ringR = r + AvatarStackService.RING;
    const dataUri = await this.readTileDataUri(tile.avatarUrl);
    // White ring drawn first (behind), so the avatar circle sits inside it — a separator against same-hue
    // backgrounds and against the canvas.
    const ring = `<circle cx="${cx}" cy="${cy}" r="${ringR}" fill="#ffffff"/>`;
    if (dataUri) {
      // Circular clip the square avatar image to the tile circle.
      return `<clipPath id="t${i}"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath>${ring}<image href="${dataUri}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#t${i})" preserveAspectRatio="xMidYMid slice"/>`;
    }
    // No avatar: a solid hsl circle (hue from a hash of the userId) + a white initial letter.
    const hue = this.hashHue(tile.userId);
    const initial = this.initial(tile.displayName);
    return `${ring}<circle cx="${cx}" cy="${cy}" r="${r}" fill="hsl(${hue},65%,55%)"/><text x="${cx}" y="${cy}" font-size="${r}" font-family="sans-serif" font-weight="600" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${this.escapeXml(initial)}</text>`;
  }

  /** Read the `-128` avatar (NOT the 512 representative — the tile is small) as a `data:` URI, or null when
   *  the sender has no avatar / the file is missing. Reuses UploadService.uploadDir + the readAvatarAsWire
   *  path-slice convention. */
  private async readTileDataUri(avatarUrl: string): Promise<string | null> {
    if (!avatarUrl?.startsWith('/uploads/')) return null;
    // Substitute the representative (-512) for the smaller -128 source (AVATAR_SIZES includes 128). Legacy
    // flat URLs and the avatars/ folder both carry the `-<size>.webp` suffix, so the swap is shape-agnostic.
    const small = avatarUrl.replace(/-\d+\.webp$/, '-128.webp');
    try {
      const buf = await readFileAsync(join(this.upload.uploadDir, small.slice('/uploads/'.length)));
      return `data:image/webp;base64,${buf.toString('base64')}`;
    } catch {
      return null; // missing/corrupt — degrade to the initial-letter circle
    }
  }

  /** A stable 0–359 hue from the userId (deterministic color per user, mirrors the web avatar palette idea). */
  private hashHue(userId: number): number {
    let h = 0;
    const s = String(userId);
    for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 360;
  }

  /** The first code point of the display name, uppercased; '?' when empty. */
  private initial(name: string): string {
    const t = (name ?? '').trim();
    return t.length > 0 ? t[0]!.toUpperCase() : '?';
  }

  /** Escape the XML-significant chars so a name/initial can never break the SVG or inject markup. */
  private escapeXml(s: string): string {
    return s.replace(/[<>&'"]/g, (c) =>
      c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : c === "'" ? '&apos;' : '&quot;',
    );
  }
}
