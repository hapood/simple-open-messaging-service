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
  // url MUST be a server-served upload path: /uploads/ followed by a flat, traversal-safe name
  // (no extra slashes, no '..', no query/fragment). This is the shape saveFile() emits (with or
  // without an extension).
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url) || url.includes('..'))
    return null;
  if (mimeType.length === 0) return null;
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) return null;
  if (name.length === 0 || name.length > MAX_FILE_NAME_LEN) return null;
  return { url, name, size, mimeType };
}
