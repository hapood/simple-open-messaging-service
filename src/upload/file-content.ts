/**
 * Generic file-attachment domain: the size cap, filename/extension helpers, and the message-content
 * shape validator. Shared between UploadService (write path) and MessageController (send path) so
 * a FILE message can only ever reference a file this server actually wrote — never an external,
 * `javascript:`, or path-traversal URL rendered into a download link.
 *
 * The open model: ANY file type is accepted at upload — there is no extension/MIME whitelist.
 * (IM apps accept arbitrary files; a fixed whitelist is the wrong model.) The security that the
 * old whitelist provided against inline-renderable types (.html/.svg/… executed in-origin) lives
 * at the SERVING layer now: bootstrap.ts forces `Content-Disposition: attachment` +
 * `X-Content-Type-Options: nosniff` on every non-image /uploads response, so a user-uploaded
 * .html/.svg/.exe is always downloaded and never rendered/sniffed in the app origin. Images stay
 * inline (avatars/chat-images are magic-byte-verified at /upload). This file therefore only owns:
 * the size cap, a sanitized on-disk extension, a display MIME, and the FILE-content shape guard.
 */

/** Per-file size cap (bytes). The global multipart limit (bootstrap.ts) is the hard ceiling above
 *  this; the service enforces this so raising the multipart limit for files does not also raise it
 *  for images (images stay capped at MAX_IMAGE_BYTES). */
import { ContentType } from '../database/enums.js';

export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Per-video size cap (bytes). The global multipart ceiling is raised to 100MB in bootstrap.ts to
 *  admit video; this is the per-route cap beneath it, enforced separately from images/files. */
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

/** Per-audio size cap (bytes). */
export const MAX_AUDIO_BYTES = 50 * 1024 * 1024;

/** Max display length of a stored filename (the upload path sanitizes/trims to this). */
export const MAX_FILE_NAME_LEN = 100;

/** A FILE message's stored content (JSON-stringified in Message.content). */
export interface FileContent {
  /** Server-relative CAS URL (`/uploads/msg-assets/<2hex>/<2hex>/<sha256>`). */
  url: string;
  /** Sanitized original filename for display. */
  name: string;
  /** File size in bytes. */
  size: number;
  /** Display mimetype (the client-declared Content-Type, or application/octet-stream). Display-only
   *  — serving forces Content-Disposition: attachment for non-images regardless of this value. */
  mimeType: string;
}

/** A VIDEO message's stored content (JSON-stringified in Message.content). w/h/duration are
 *  client-probed (<video> loadedmetadata) and server-untrusted — the server validated only the
 *  container family, not the codec/dimensions. They drive layout + the duration badge, nothing more. */
export interface VideoContent {
  url: string;
  name: string;
  size: number;
  mimeType: string;
  w: number;
  h: number;
  duration: number; // seconds
}

/** An AUDIO message's stored content. duration is client-probed (<audio> loadedmetadata),
 *  server-untrusted — display only. */
export interface AudioContent {
  url: string;
  name: string;
  size: number;
  mimeType: string;
  duration: number; // seconds
}

/** Max stored length of a LINK card's display fields. LinkPreviewService caps these at the source
 *  (page probe); re-checked here so a hand-crafted payload can never store a megabyte of title.
 *  Comfortably within the 5000-char content budget. */
const MAX_LINK_TITLE_LEN = 300;
const MAX_LINK_DESC_LEN = 500;
const MAX_LINK_SITE_NAME_LEN = 100;
/** A LINK message's strict stored content. Image fields contain server-relative CAS URLs. Title and
 *  description are always present,
 *  including when metadata extraction produced an empty string. */
export interface LinkContent {
  /** Canonical page URL after redirect resolution; http(s) only. */
  url: string;
  /** Page title (og:title → twitter:title → <title>), length-capped. */
  title: string;
  /** Page description, length-capped. */
  description: string;
  /** Open Graph publisher/site name, length-capped. */
  siteName?: string;
  /** Content-addressed page image thumbnail URL; omitted when unavailable. */
  image?: string;
  /** Content-addressed favicon thumbnail URL; omitted when unavailable. */
  favicon?: string;
}

/**
 * Lowercased, sanitized on-disk extension (no dot) parsed from a filename: only [a-z0-9], 1–16
 * chars. Returns '' for no extension OR an extension that is not a safe on-disk token (weird /
 * over-long / non-alpha extensions are dropped rather than written to disk). '' is a valid result:
 * the file is stored with no extension and served as application/octet-stream + attachment.
 */
export function parseFileExt(filename: string): string {
  const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
  const base = slash >= 0 ? filename.slice(slash + 1) : filename;
  const dot = base.lastIndexOf('.');
  if (dot < 0) return '';
  const raw = base.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,16}$/.test(raw) ? raw : '';
}

const MIME_RE = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i;

/** Matches the pure content-addressed URL emitted by UploadService. Filename, MIME and message type
 * are presentation metadata and deliberately never participate in CAS identity. */
const CAS_UPLOAD_URL_RE =
  /^\/uploads\/msg-assets\/([0-9a-f]{2})\/([0-9a-f]{2})\/([0-9a-f]{64})$/;

/** Whether a url is an accepted server-served upload path — a CAS shard URL. Rejects traversal
 *  ('..'), query/fragment, and any shape saveCas() would never emit. Shared by parseFileContent and
 *  the VIDEO/AUDIO content validators. */
export function isUploadUrl(url: string): boolean {
  if (url.includes('..')) return false;
  const match = CAS_UPLOAD_URL_RE.exec(url);
  return Boolean(
    match &&
      match[1] === match[3].slice(0, 2) &&
      match[2] === match[3].slice(2, 4),
  );
}

/** Global capture of the digest inside a CAS shard URL. Used by extractDigests to pull every sha256
 *  referenced by a message's content string (IMAGE/FILE/VIDEO/AUDIO) so MediaMessage authz rows can be
 *  written at send time. */
const SHARD_DIGEST_RE =
  /\/uploads\/msg-assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})(?![0-9a-f])/g;

/** Extract every distinct CAS digest referenced by a message's raw content string. Scans the whole
 *  JSON (works for single-image `{url,...}`, FILE/VIDEO/AUDIO shapes, and future album arrays alike)
 *  and de-duplicates — one MediaMessage row per (message, digest). Returns [] for PURE_TEXT. */
export function extractDigests(content: string): string[] {
  if (!content) return [];
  const out = new Set<string>();
  for (const m of content.matchAll(SHARD_DIGEST_RE)) out.add(m[1]);
  return [...out];
}

/** Compatibility shape used by federation callers. `ext` is presentation metadata only and is no
 * longer recovered from or written into the CAS URL/path. */
export function extractDigestEntries(
  content: string,
): Array<{ digest: string; ext: string }> {
  return extractDigests(content).map((digest) => ({ digest, ext: '' }));
}

/**
 * Resolve a safe on-disk extension and a display MIME for an accepted upload. The open model
 * rejects nothing here (any type is allowed; security is at serving) — the caller rejects only on
 * a missing filename or empty buffer. The extension comes from the client filename (sanitized); the
 * MIME is the client-declared Content-Type when it parses as a MIME token, else
 * application/octet-stream. The MIME is display-only (icon tint); serving ignores it for
 * non-images.
 */
export function resolveFileType(
  filename: string,
  declaredMime: string,
): { ext: string; mime: string } {
  return {
    ext: parseFileExt(filename),
    mime:
      typeof declaredMime === 'string' && MIME_RE.test(declaredMime)
        ? declaredMime
        : 'application/octet-stream',
  };
}

/**
 * Validate + parse a FILE message's content string. Returns the typed content, or null if the
 * shape is wrong or the url/name/mimeType are not server-trusted (defense against a client forging
 * a `javascript:` / external / traversal URL into a rendered download link). mimeType is NOT
 * whitelisted (the open model accepts any type) — it only needs to be a non-empty string, since
 * serving forces a safe disposition and the URL-shape check below is the real boundary.
 */
export function parseFileContent(content: string): FileContent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const { url, name, size, mimeType } = obj as Record<string, unknown>;
  if (
    typeof url !== 'string' ||
    typeof name !== 'string' ||
    typeof size !== 'number' ||
    typeof mimeType !== 'string'
  ) {
    return null;
  }
  // url MUST be a server-served CAS shard path (the only shape saveCas emits). isUploadUrl rejects
  // traversal, query/fragment, and any other shape.
  if (!isUploadUrl(url)) return null;
  if (mimeType.length === 0) return null;
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) return null;
  if (name.length === 0 || name.length > MAX_FILE_NAME_LEN) return null;
  return { url, name, size, mimeType };
}

/** Coerce an unknown value to a finite positive number within (0, max], else null. Used for the
 *  client-probed w/h/duration fields on VIDEO/AUDIO content — accept any reasonable value, reject
 *  non-numbers / NaN / absurd sizes (defensive against a malformed or hostile payload). */
function parseFinitePos(value: unknown, max: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value <= 0 || value > max) return null;
  return value;
}

/**
 * Validate + parse a VIDEO message's content. Mirrors parseFileContent's contract (server-served url,
 * bounded size, non-empty name/mime) and additionally accepts the client-probed w/h/duration as
 * display-only numbers within sane bounds. Returns null on any shape violation — the controller maps
 * that to a 400 so a client cannot forge arbitrary content under the VIDEO type.
 */
export function parseVideoContent(content: string): VideoContent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const { url, name, size, mimeType, w, h, duration } = obj as Record<
    string,
    unknown
  >;
  if (
    typeof url !== 'string' ||
    typeof name !== 'string' ||
    typeof size !== 'number' ||
    typeof mimeType !== 'string'
  ) {
    return null;
  }
  const wv = parseFinitePos(w, 100000); // 100k px — well past 8K, rejects absurd values
  const hv = parseFinitePos(h, 100000);
  const dv = parseFinitePos(duration, 86400); // 24h cap on a single clip
  if (wv === null || hv === null || dv === null) return null;
  if (!isUploadUrl(url)) return null;
  if (mimeType.length === 0) return null;
  if (!Number.isFinite(size) || size <= 0 || size > MAX_VIDEO_BYTES)
    return null;
  if (name.length === 0 || name.length > MAX_FILE_NAME_LEN) return null;
  return { url, name, size, mimeType, w: wv, h: hv, duration: dv };
}

/**
 * Validate + parse an AUDIO message's content. Same contract as parseVideoContent minus w/h.
 */
export function parseAudioContent(content: string): AudioContent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const { url, name, size, mimeType, duration } = obj as Record<
    string,
    unknown
  >;
  if (
    typeof url !== 'string' ||
    typeof name !== 'string' ||
    typeof size !== 'number' ||
    typeof mimeType !== 'string'
  ) {
    return null;
  }
  const dv = parseFinitePos(duration, 86400);
  if (dv === null) return null;
  if (!isUploadUrl(url)) return null;
  if (mimeType.length === 0) return null;
  if (!Number.isFinite(size) || size <= 0 || size > MAX_AUDIO_BYTES)
    return null;
  if (name.length === 0 || name.length > MAX_FILE_NAME_LEN) return null;
  return { url, name, size, mimeType, duration: dv };
}

/**
 * Validate + parse a LINK message's content string. A FORM check only — no network. `url` must be an
 * http(s) URL, and `image` (if present) MUST be a server-served CAS shard (`isUploadUrl`):
 * LinkPreviewService localizes og:image into CAS, so any non-upload image URL here is a forged
 * payload that would render a cross-origin / `javascript:` image. The real SSRF screening of the
 * target page happens at fetch time in SafeFetchService; this guard only ensures a persisted LINK
 * row can never carry an unsafe URL. Returns the typed content, or null on any shape violation.
 */
export function parseLinkContent(content: string): LinkContent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const record = obj as Record<string, unknown>;
  const allowed = new Set([
    'url',
    'title',
    'description',
    'siteName',
    'image',
    'favicon',
  ]);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  const { url, title, description, siteName, image, favicon } = record;
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  if (typeof title !== 'string' || typeof description !== 'string') return null;
  if (title.length > MAX_LINK_TITLE_LEN) return null;
  if (description.length > MAX_LINK_DESC_LEN) return null;
  if (
    siteName !== undefined &&
    (typeof siteName !== 'string' || siteName.length > MAX_LINK_SITE_NAME_LEN)
  )
    return null;
  if (
    image !== undefined &&
    (typeof image !== 'string' || !isUploadUrl(image))
  )
    return null;
  if (
    favicon !== undefined &&
    (typeof favicon !== 'string' || !isUploadUrl(favicon))
  )
    return null;
  return {
    url,
    title,
    description,
    siteName: siteName || undefined,
    image: image || undefined,
    favicon: favicon || undefined,
  };
}

// ─── Phase 7: type-agnostic outbound upload (design doc §12.3) ───────────────────────────────

/** The server-detected family of one uploaded file, derived from magic bytes (isImage/detectMedia).
 *  This is independent of the message-level contentType (IMAGE/FILE/VIDEO/AUDIO/GALLERY), which the
 *  client sets at stage time. The family drives the trusted on-disk extension, the FileSyncProgress
 *  kind, and — for a GALLERY bundle — each item's self-describing `kind`. */
export type OutboundFileFamily = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';

/** Per-file payload produced by the type-agnostic upload and stored on the batch's
 *  FileSyncProgress(OUTBOUND, SUCCEEDED) row. The barrier-promote assembles message content from these
 *  payloads without re-deriving display metadata from CAS. `url` is the uncontextualized CAS shard URL
 *  (/uploads/msg-assets/<shard>); contextualizeCasUrls rewrites every URL at promote time. */
export interface OutboundFilePayload {
  digest: string;
  url: string;
  size: number;
  family: OutboundFileFamily;
  /** Sanitized display filename (FILE/VIDEO/AUDIO). Omitted for IMAGE. */
  name?: string;
  /** Display MIME (FILE/VIDEO/AUDIO). Omitted for IMAGE. */
  mimeType?: string;
  /** Image/video pixel width (client-companion field). */
  w?: number;
  /** Image/video pixel height (client-companion field). */
  h?: number;
  /** Video/audio duration in seconds (client-companion field). */
  duration?: number;
}

/** Map a detected file family to the FileSyncProgress kind value. GALLERY bundles use per-item kinds
 *  on their FileSyncProgress rows; the BUNDLE kind is reserved for inbound federation only. */
export function familyToFileSyncKind(
  family: OutboundFileFamily,
): 'FILE' | 'IMAGE' | 'VIDEO' | 'AUDIO' {
  return family;
}

/** One element of a GALLERY message's `items` array. `kind` self-describes so the renderer picks the
 *  right row component — a GALLERY may mix image/video/file/audio items. */
export interface GalleryItem {
  kind: OutboundFileFamily;
  url: string;
  size: number;
  name?: string;
  mimeType?: string;
  w?: number;
  h?: number;
  duration?: number;
}

/**
 * Assemble the final message content JSON for an outbound batch from its per-file payloads.
 *
 * Single-file (IMAGE/FILE/VIDEO/AUDIO): the unchanged per-type object shape, so rendering is identical
 * to the legacy typed-upload path — the payload already carries every display field the client used to
 * send at stage time (now it rides with the upload part).
 *
 * GALLERY: `{ items: [...] }`, digest-sorted so the same batch always assembles the same message
 * regardless of which parallel upload request landed last. Returns the JSON string; the caller runs
 * contextualizeCasUrls on it (which rewrites every CAS URL in one pass).
 */
export function assembleOutboundContent(
  contentType: ContentType,
  payloads: OutboundFilePayload[],
): string {
  const byDigest = [...payloads].sort((a, b) =>
    a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0,
  );
  if (contentType === ContentType.GALLERY) {
    const items: GalleryItem[] = byDigest.map((p) => ({
      kind: p.family,
      url: p.url,
      size: p.size,
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.mimeType !== undefined ? { mimeType: p.mimeType } : {}),
      ...(p.w !== undefined ? { w: p.w } : {}),
      ...(p.h !== undefined ? { h: p.h } : {}),
      ...(p.duration !== undefined ? { duration: p.duration } : {}),
    }));
    return JSON.stringify({ items });
  }
  const p = byDigest[0];
  switch (contentType) {
    case ContentType.IMAGE:
      return JSON.stringify({
        url: p.url,
        w: p.w ?? 0,
        h: p.h ?? 0,
        size: p.size,
      });
    case ContentType.FILE:
      return JSON.stringify({
        url: p.url,
        name: p.name ?? 'file',
        size: p.size,
        mimeType: p.mimeType ?? 'application/octet-stream',
      });
    case ContentType.VIDEO:
      return JSON.stringify({
        url: p.url,
        name: p.name ?? 'video',
        size: p.size,
        mimeType: p.mimeType ?? 'video/mp4',
        w: p.w ?? 0,
        h: p.h ?? 0,
        duration: p.duration ?? 0,
      });
    case ContentType.AUDIO:
      return JSON.stringify({
        url: p.url,
        name: p.name ?? 'audio',
        size: p.size,
        mimeType: p.mimeType ?? 'audio/mpeg',
        duration: p.duration ?? 0,
      });
    default:
      return JSON.stringify({ url: p.url, size: p.size });
  }
}
