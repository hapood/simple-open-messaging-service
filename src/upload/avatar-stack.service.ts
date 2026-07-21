import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { existsSync, readFile, writeFile, rename, mkdir, readdir, stat, unlink } from 'fs';
import { join, dirname } from 'path';
import { createHash, randomBytes } from 'crypto';
import { promisify } from 'util';
import sharp from 'sharp';
import { UploadService } from './upload.service.js';

const readFileAsync = promisify(readFile);
const writeFileAsync = promisify(writeFile);
const renameAsync = promisify(rename);
const mkdirAsync = promisify(mkdir);
const readdirAsync = promisify(readdir);
const statAsync = promisify(stat);
const unlinkAsync = promisify(unlink);

/**
 * Composites a "stacked avatar" PNG — N sender avatars drawn overlapping on a transparent canvas — served
 * as a notification's single `icon`. Every platform's notification icon slot accepts exactly ONE image
 * (Web `icon`, Android `setLargeIcon`, Tauri single icon) with no multi-layer layout, so the only way to
 * render a stack across all platforms is to pre-composite it into one bitmap. The server is the right place
 * to do that: it already has every sender's avatar on disk (flat multi-size webp), and compositing here
 * means the three clients (SW / Kotlin / foreground) each just fetch one URL — no triplicated canvas code
 * (the SW fetching + decoding N avatars would be especially heavy).
 *
 * Pipeline: one SVG (transparent canvas + N rounded-square-clipped `<image>`s or initial-letter rounded
 * squares + white borders) → sharp renders it to PNG → atomic tmp+rename into the cache. sharp's first
 * `.composite()`-free render path: the SVG itself carries the layout (rounded-square clips, borders,
 * initials), so a single `sharp(svg).png()` produces the final image. librsvg (bundled in the prebuilt
 * sharp linux-x64 binary) renders the SVG; if it is ever unavailable the render throws and we degrade to
 * `null` (the client falls back to its app icon) — graceful, never a 500.
 *
 * Cache: keyed by the sorted `(userId, avatarUrl, displayName)` tuples (sort → order-independent), stored
 * at `data/uploads/notif-icons/<sha1>.png`. Served by the EXISTING `/uploads/*` static handler (no new
 * route), so it inherits the media_token-cookie auth gate + `Cache-Control: private, max-age=300`.
 * Invalidation is automatic: a user changing their avatar changes their `avatarUrl` → the key changes → a
 * fresh composite. The OLD composite is orphaned by that key change, so a TTL sweep ({@link gc}) reaps
 * anything older than {@link MAX_AGE_MS} — a notif-icon renders one momentary unread summary (the client
 * caches it max-age=300), so an hour-old file is stale + unreachable. Without the sweep the dir would grow
 * unbounded (every distinct sender set + every avatar change writes a new file, none ever deleted).
 */
@Injectable()
export class AvatarStackService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AvatarStackService.name);

  /** Maximum senders drawn — beyond this the stack is illegible; the body's "+N" carries the rest. */
  static readonly MAX_TILES = 4;
  /** The on-disk namespace under data/uploads/ — served as /uploads/notif-icons/*. */
  static readonly DIR_REL = 'notif-icons';

  /** Canvas side (px). 192 ≥ Android `setLargeIcon` (64dp @ 3x) and a Web Push icon, so the avatar renders
   *  crisp on every platform; square so it fills the icon slot. (A 128px canvas with a 56px tile left a
   *  single-sender avatar at ~44% of the icon — the "tiny avatar" bug.) */
  private static readonly CANVAS = 192;
  /** Outer padding (px) — keeps a single-sender tile off the canvas edge. */
  private static readonly PAD = 8;
  /** White separator border thickness (px) drawn around each tile (the stack separator). */
  private static readonly BORDER = 3;
  /** Center-to-center spacing as a fraction of the tile side for a stack (< 1 → overlap). */
  private static readonly OVERLAP = 0.55;
  /** Tile corner radius as a fraction of the side — matches the app's WeChat-style rounded-square avatars
   *  (`user-avatar` rx=20%); the notification avatar is the SAME shape as the in-app avatar, not a circle. */
  private static readonly RADIUS_FRAC = 0.20;

  /** How often the orphan-TTL sweep runs ({@link gc}). */
  private static readonly GC_INTERVAL_MS = 60 * 60 * 1000; // 1h
  /** A notif-icon older than this is stale + unreachable → reaped by {@link gc} to bound the on-disk cache. */
  private static readonly MAX_AGE_MS = 60 * 60 * 1000; // 1h (≫ the client's max-age=300)
  private gcTimer: NodeJS.Timeout | undefined;

  constructor(private readonly upload: UploadService) {}

  async onModuleInit() {
    // Reap orphaned/expired notif-icons hourly (mirrors the kv-store / brute-force setInterval convention).
    this.gcTimer = setInterval(() => {
      void this.gc().catch((e) => this.logger.warn(`avatar-stack gc failed: ${(e as Error).message}`));
    }, AvatarStackService.GC_INTERVAL_MS);
  }

  onModuleDestroy() {
    if (this.gcTimer) clearInterval(this.gcTimer);
  }

  /** Best-effort: delete `notif-icons/*.png` older than {@link MAX_AGE_MS}. Never throws — a racing compose
   *  simply re-creates the file on its next miss. */
  private async gc(): Promise<void> {
    const dir = join(this.upload.uploadDir, AvatarStackService.DIR_REL);
    let entries: string[];
    try {
      entries = await readdirAsync(dir);
    } catch {
      return; // dir missing (no icon ever composed) → nothing to reap
    }
    const cutoff = Date.now() - AvatarStackService.MAX_AGE_MS;
    await Promise.all(
      entries.map(async (name) => {
        if (!name.endsWith('.png')) return;
        const p = join(dir, name);
        try {
          const st = await statAsync(p);
          if (st.mtimeMs < cutoff) await unlinkAsync(p);
        } catch {
          /* racing compose/delete — best-effort */
        }
      }),
    );
  }

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
    const side = AvatarStackService.tileSide(tiles.length);
    const offsets = this.layout(tiles.length, side);
    const parts: string[] = [];
    for (let i = 0; i < tiles.length; i++) {
      parts.push(await this.tileSvg(tiles[i], offsets[i], i, side));
    }
    if (parts.length === 0) return null;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${AvatarStackService.CANVAS}" height="${AvatarStackService.CANVAS}">${parts.join('')}</svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }

  /** Center-x positions for `n` tiles of side `d`, horizontally centered with ~{@link OVERLAP} overlap
   *  (a real stack). Single sender → centered (no stack). */
  private layout(n: number, d: number): number[] {
    const c = AvatarStackService.CANVAS;
    if (n === 1) return [c / 2];
    const offset = d * AvatarStackService.OVERLAP; // < d so consecutive tiles overlap
    const groupWidth = d + offset * (n - 1);
    const startX = (c - groupWidth) / 2 + d / 2;
    return Array.from({ length: n }, (_, i) => startX + offset * i);
  }

  /** Tile side (px) for `n` senders. A single sender fills the canvas (PAD each side) so its avatar is large
   *  in the icon slot; a stack shrinks the tiles so up to {@link MAX_TILES} faces overlap legibly. Derived
   *  from {@link OVERLAP} so the group exactly fits the padded canvas (no drift between sizing + layout). */
  private static tileSide(n: number): number {
    const usable = AvatarStackService.CANVAS - 2 * AvatarStackService.PAD;
    if (n <= 1) return usable;
    return Math.round(usable / (1 + AvatarStackService.OVERLAP * (n - 1)));
  }

  /** One tile's SVG fragment at center-x `cx` with side `side`: a white rounded-square border + either the
   *  avatar (rounded-square-clipped) or an initial-letter colored rounded square (when the sender has no
   *  avatar / the file can't be read). The shape matches the in-app avatar (rx=20% rounded square). */
  private async tileSvg(
    tile: { avatarUrl: string; displayName: string; userId: number },
    cx: number,
    i: number,
    side: number,
  ): Promise<string> {
    const cy = AvatarStackService.CANVAS / 2;
    const half = side / 2;
    const x = cx - half;
    const y = cy - half;
    const rx = side * AvatarStackService.RADIUS_FRAC;
    const b = AvatarStackService.BORDER;
    const dataUri = await this.readTileDataUri(tile.avatarUrl);
    // White rounded-square border drawn first (behind) — the separator between overlapping tiles and against
    // the canvas. Same RADIUS_FRAC so the border traces the rounded silhouette.
    const border = `<rect x="${x - b}" y="${y - b}" width="${side + 2 * b}" height="${side + 2 * b}" rx="${(side + 2 * b) * AvatarStackService.RADIUS_FRAC}" fill="#ffffff"/>`;
    if (dataUri) {
      // Clip the square avatar image to the rounded-square tile (matches the in-app avatar shape).
      return `<clipPath id="t${i}"><rect x="${x}" y="${y}" width="${side}" height="${side}" rx="${rx}"/></clipPath>${border}<image href="${dataUri}" x="${x}" y="${y}" width="${side}" height="${side}" clip-path="url(#t${i})" preserveAspectRatio="xMidYMid slice"/>`;
    }
    // No avatar: a solid hsl rounded square (hue from a hash of the userId) + a white initial letter — the
    // same shape as the app's initial-letter avatar.
    const hue = this.hashHue(tile.userId);
    const initial = this.initial(tile.displayName);
    return `${border}<rect x="${x}" y="${y}" width="${side}" height="${side}" rx="${rx}" fill="hsl(${hue},65%,55%)"/><text x="${cx}" y="${cy}" font-size="${Math.round(side * 0.5)}" font-family="sans-serif" font-weight="600" fill="#ffffff" text-anchor="middle" dominant-baseline="central">${this.escapeXml(initial)}</text>`;
  }

  /** Read the `-256` avatar (a single-sender tile can be ~176px, so -256 downscales crisply where -128 went
   *  soft) as a `data:` URI, or null when the sender has no avatar / the file is missing. Reuses
   *  UploadService.uploadDir + the readAvatarAsWire path-slice convention. */
  private async readTileDataUri(avatarUrl: string): Promise<string | null> {
    if (!avatarUrl?.startsWith('/uploads/')) return null;
    // Swap the representative (-512) for the -256 source (AVATAR_SIZES includes 256). Legacy flat URLs (no
    // size suffix) pass through unchanged.
    const small = avatarUrl.replace(/-\d+\.webp$/, '-256.webp');
    try {
      const buf = await readFileAsync(join(this.upload.uploadDir, small.slice('/uploads/'.length)));
      return `data:image/webp;base64,${buf.toString('base64')}`;
    } catch {
      return null; // missing/corrupt — degrade to the initial-letter rounded square
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
