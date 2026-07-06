/**
 * Shared FILE-message presentational helpers — pure functions over a {@link FileInfo}-like payload, used by both the
 * file row (the compact bubble) and the file-detail overlay (the fullscreen inspector). Extracted so the icon tint,
 * the extension badge, and the human-readable size render identically in the two places that show a file.
 */

/** Display category derived from mimeType (drives the icon tint). The backend accepts any file
 *  type (open model), so unknown MIMEs fall through to the generic 'file' category. */
export type FileCategory =
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'archive'
  | 'text'
  | 'file';

export function categorize(mimeType: string): FileCategory {
  if (mimeType === 'application/pdf') return 'pdf';
  if (
    mimeType === 'application/msword' ||
    mimeType === 'application/rtf' ||
    mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.wordprocessingml',
    )
  ) {
    return 'doc';
  }
  if (
    mimeType === 'application/vnd.ms-excel' ||
    mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.spreadsheetml',
    )
  ) {
    return 'sheet';
  }
  if (
    mimeType === 'application/vnd.ms-powerpoint' ||
    mimeType.startsWith(
      'application/vnd.openxmlformats-officedocument.presentationml',
    )
  ) {
    return 'slides';
  }
  if (
    mimeType === 'application/zip' ||
    mimeType === 'application/x-zip-compressed' ||
    mimeType === 'application/x-tar' ||
    mimeType === 'application/gzip' ||
    mimeType === 'application/x-gzip' ||
    mimeType === 'application/x-7z-compressed' ||
    mimeType === 'application/x-rar-compressed'
  ) {
    return 'archive';
  }
  if (
    mimeType.startsWith('text/') ||
    mimeType === 'application/json' ||
    mimeType === 'application/xml'
  ) {
    return 'text';
  }
  return 'file';
}

/** Human-readable byte size (B / KB / MB / GB). Empty for 0/unknown. */
export function formatBytes(n: number): string {
  if (!n || n <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/** Uppercased extension badge from the trusted server-sanitized filename; 'FILE' when there is no dot. */
export function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  return i >= 0 ? name.slice(i + 1).toUpperCase() : 'FILE';
}
