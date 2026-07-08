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
  /** Server-relative URL of the stored file; always `/uploads/<safe-name>`. */
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

/** Matches a content-addressed upload URL: /uploads/shards/<2-hex>/<2-hex>/<64-hex-sha256>.<ext>.
 *  The shape UploadService.saveCas() emits. The digest is exactly 64 lowercase hex chars (sha256);
 *  the ext matches parseFileExt's [A-Za-z0-9]{1,16} shape. */
const CAS_UPLOAD_URL_RE =
  /^\/uploads\/shards\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}\.[A-Za-z0-9]{1,16}$/;

/** Matches a legacy flat upload URL: /uploads/<flat-name> (pre-CAS files). Kept so existing FILE
 *  messages with flat URLs still validate after the CAS switch (natural attrition, no migration). */
const FLAT_UPLOAD_URL_RE = /^\/uploads\/[A-Za-z0-9._-]+$/;

/** Whether a url is an accepted server-served upload path — CAS sharded OR legacy flat. Rejects
 *  traversal ('..'), query/fragment, and any shape saveCas()/saveFile() would never emit. Shared by
 *  parseFileContent and the VIDEO/AUDIO content validators. */
export function isUploadUrl(url: string): boolean {
  if (url.includes('..')) return false;
  return CAS_UPLOAD_URL_RE.test(url) || FLAT_UPLOAD_URL_RE.test(url);
}

/** Global capture of the digest inside a CAS shard URL. Used by extractDigests to pull every sha256
 *  referenced by a message's content string (IMAGE/FILE/VIDEO/AUDIO) so MediaMessage authz rows can be
 *  written at send time. Legacy flat URLs have no digest and are intentionally ignored. */
const SHARD_DIGEST_RE = /\/uploads\/shards\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})\./g;

/** Extract every distinct CAS digest referenced by a message's raw content string. Scans the whole
 *  JSON (works for single-image `{url,...}`, FILE/VIDEO/AUDIO shapes, and future album arrays alike)
 *  and de-duplicates — one MediaMessage row per (message, digest). Returns [] for PURE_TEXT and for
 *  content that references only legacy-flat URLs (no digest → no authz row → served auth-n-only). */
export function extractDigests(content: string): string[] {
  if (!content) return [];
  const out = new Set<string>();
  for (const m of content.matchAll(SHARD_DIGEST_RE)) out.add(m[1]);
  return [...out];
}

/** Same scan as extractDigests, but also captures the on-disk extension — the RECEIVER uses this to
 *  fetch + localize each media asset via /get_file (the ext names the local CAS file so it serves
 *  same-origin with the right mime via @fastify/static). De-duplicated by digest (a digest has one ext).
 *  Legacy flat URLs have no digest and are ignored. */
const SHARD_DIGEST_EXT_RE =
  /\/uploads\/shards\/[0-9a-f]{2}\/[0-9a-f]{2}\/([0-9a-f]{64})\.([A-Za-z0-9]{1,16})/g;
export function extractDigestEntries(
  content: string,
): Array<{ digest: string; ext: string }> {
  if (!content) return [];
  const map = new Map<string, string>();
  for (const m of content.matchAll(SHARD_DIGEST_EXT_RE)) map.set(m[1], m[2]);
  return [...map.entries()].map(([digest, ext]) => ({ digest, ext }));
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
    mime: typeof declaredMime === 'string' && MIME_RE.test(declaredMime)
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
  // url MUST be a server-served upload path — CAS sharded (saveCas) or legacy flat (pre-CAS).
  // isUploadUrl rejects traversal, query/fragment, and any other shape.
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
  if (!Number.isFinite(size) || size <= 0 || size > MAX_VIDEO_BYTES) return null;
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
  const { url, name, size, mimeType, duration } = obj as Record<string, unknown>;
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
  if (!Number.isFinite(size) || size <= 0 || size > MAX_AUDIO_BYTES) return null;
  if (name.length === 0 || name.length > MAX_FILE_NAME_LEN) return null;
  return { url, name, size, mimeType, duration: dv };
}
