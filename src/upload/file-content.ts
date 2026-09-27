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
interface FileContent {
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

/** Max stored length of a LINK card's display fields. LinkPreviewService caps these at the source
 *  (page probe); re-checked here so a hand-crafted payload can never store a megabyte of title.
 *  Comfortably within the local 4000-code-point input budget. */
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
function isUploadUrl(url: string): boolean {
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

export interface DigestFileRef {
  digest: string;
  name: string;
  size?: number;
}

function visitDigestObjects(
  content: string,
  onDigestObject: (
    digest: string,
    item: Record<string, unknown>,
  ) => void,
): void {
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (typeof item.url === 'string') {
      const match = CAS_UPLOAD_URL_RE.exec(item.url);
      if (match) onDigestObject(match[3], item);
    }
    Object.values(item).forEach(visit);
  };
  visit(JSON.parse(content));
}

export function extractDigestEntries(
  content: string,
): Array<{ digest: string; size?: number }> {
  const sizes = new Map<string, number>();
  visitDigestObjects(content, (digest, item) => {
    if (
      typeof item.size === 'number' &&
      Number.isSafeInteger(item.size) &&
      item.size >= 0
    ) {
      sizes.set(digest, Math.max(sizes.get(digest) ?? 0, item.size));
    }
  });
  return extractDigests(content).map((digest) => ({
    digest,
    size: sizes.get(digest),
  }));
}

export function extractDigestFileRefs(content: string): DigestFileRef[] {
  const refs = new Map<string, DigestFileRef>();
  visitDigestObjects(content, (digest, item) => {
    if (refs.has(digest)) return;
    if (typeof item.name !== 'string' || item.name.length === 0) {
      throw new Error('media digest is missing a filename');
    }
    refs.set(digest, {
      digest,
      name: item.name,
      ...(typeof item.size === 'number' &&
      Number.isSafeInteger(item.size) &&
      item.size >= 0
        ? { size: item.size }
        : {}),
    });
  });
  return [...refs.values()];
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

/** Validate the stored LINK card after its owned preview generation completes.
 * Page URLs are HTTP(S); thumbnails must be this server's CAS assets. Reject
 * unknown keys so client-authored metadata cannot silently enter storage. */
export function parseLinkContent(content: string): LinkContent | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const card = value as Record<string, unknown>;
  if (
    Object.keys(card).some(
      (key) =>
        ![
          'url',
          'title',
          'description',
          'siteName',
          'image',
          'favicon',
        ].includes(key),
    ) ||
    typeof card.url !== 'string' ||
    !/^https?:\/\//i.test(card.url) ||
    typeof card.title !== 'string' ||
    card.title.length > MAX_LINK_TITLE_LEN ||
    typeof card.description !== 'string' ||
    card.description.length > MAX_LINK_DESC_LEN ||
    ('siteName' in card &&
      (typeof card.siteName !== 'string' ||
        card.siteName.length > MAX_LINK_SITE_NAME_LEN)) ||
    ('image' in card &&
      (typeof card.image !== 'string' || !isUploadUrl(card.image))) ||
    ('favicon' in card &&
      (typeof card.favicon !== 'string' || !isUploadUrl(card.favicon)))
  )
    return null;
  try {
    const page = new URL(card.url);
    if (
      !['http:', 'https:'].includes(page.protocol) ||
      !page.hostname ||
      page.username ||
      page.password
    )
      return null;
  } catch {
    return null;
  }
  return card as unknown as LinkContent;
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
// ─── Phase 7: type-agnostic outbound upload (design doc §12.3) ───────────────────────────────

/** The server-detected family of one uploaded file, derived from magic bytes (isImage/detectMedia).
 *  This is independent of the message-level contentType (IMAGE/FILE/VIDEO/AUDIO/GALLERY), which the
 *  client sets at stage time. The family drives the trusted on-disk extension, the FileSyncProgress
 *  kind, and — for a GALLERY bundle — each item's self-describing `kind`. */
export type OutboundFileFamily = 'IMAGE' | 'VIDEO' | 'AUDIO' | 'FILE';

/** Per-file payload produced by the type-agnostic upload and stored on the batch's
 *  FileSyncProgress(OUTBOUND, SUCCEEDED) row. The barrier-promote assembles message content from these
 *  payloads without re-deriving display metadata from CAS. `url` is the canonical CAS shard URL
 *  (/uploads/msg-assets/<shard>); message coordinates are not stored in attachment content. */
export interface OutboundFilePayload {
  digest: string;
  url: string;
  size: number;
  family: OutboundFileFamily;
  /** Sanitized display filename. */
  name: string;
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
interface GalleryItem {
  kind: OutboundFileFamily;
  url: string;
  size: number;
  name: string;
  mimeType?: string;
  w?: number;
  h?: number;
  duration?: number;
}

/**
 * Assemble the final message content JSON for an outbound batch from its per-file payloads.
 *
 * Single-file (IMAGE/FILE/VIDEO/AUDIO): the payload carries every display field captured at stage time.
 *
 * GALLERY: `{ items: [...] }`, digest-sorted so the same batch always assembles the same message
 * regardless of which parallel upload request landed last. Returns the canonical JSON string.
 */
export function assembleOutboundContent(
  contentType: ContentType,
  payloads: OutboundFilePayload[],
): string {
  if (contentType === ContentType.GALLERY) {
    const items: GalleryItem[] = payloads.map((p) => ({
      kind: p.family,
      url: p.url,
      size: p.size,
      name: p.name,
      ...(p.mimeType !== undefined ? { mimeType: p.mimeType } : {}),
      ...(p.w !== undefined ? { w: p.w } : {}),
      ...(p.h !== undefined ? { h: p.h } : {}),
      ...(p.duration !== undefined ? { duration: p.duration } : {}),
    }));
    return JSON.stringify({ items });
  }
  const p = payloads[0];
  switch (contentType) {
    case ContentType.IMAGE:
      return JSON.stringify({
        url: p.url,
        w: p.w ?? 0,
        h: p.h ?? 0,
        size: p.size,
        name: p.name,
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
