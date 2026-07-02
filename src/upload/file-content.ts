/**
 * Generic file-attachment domain: the upload whitelist, the size cap, and the message-content
 * shape validator. Shared between UploadService (write path) and MessageController (send path) so
 * a FILE message can only ever reference a file this server actually wrote — never an external,
 * `javascript:`, or path-traversal URL rendered into a download link.
 */

/** Allowed generic-file mimetypes → on-disk extension (whitelist; no executables/scripts). */
export const FILE_MIME_EXT: Readonly<Record<string, string>> = {
  // documents
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
    'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation':
    'pptx',
  'application/rtf': 'rtf',
  // archives
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'application/x-tar': 'tar',
  'application/gzip': 'gz',
  'application/x-gzip': 'gz',
  'application/x-7z-compressed': '7z',
  'application/x-rar-compressed': 'rar',
  // text/data
  'text/plain': 'txt',
  'text/csv': 'csv',
  'text/markdown': 'md',
  'application/json': 'json',
  'application/xml': 'xml',
};

/** Per-file size cap (bytes). The global multipart limit (bootstrap.ts) is the hard ceiling above
 * this; the service enforces this so raising the multipart limit for files does not also raise it
 * for images (images stay capped at MAX_IMAGE_BYTES). */
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
  /** Validated mimetype (a key of FILE_MIME_EXT). */
  mimeType: string;
}

/**
 * Validate + parse a FILE message's content string. Returns the typed content, or null if the
 * shape is wrong or the url/mimeType are not server-trusted (defense against a client forging a
 * `javascript:` / external / traversal URL or a disallowed type into a rendered download link).
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
  // (no extra slashes, no '..', no query/fragment). This is the shape saveFile() emits.
  if (!/^\/uploads\/[A-Za-z0-9._-]+$/.test(url) || url.includes('..'))
    return null;
  if (!(mimeType in FILE_MIME_EXT)) return null;
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) return null;
  if (name.length === 0 || name.length > MAX_FILE_NAME_LEN) return null;
  return { url, name, size, mimeType };
}
