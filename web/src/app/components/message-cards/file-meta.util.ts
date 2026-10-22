/**
 * Shared FILE-message presentational helpers — pure functions over a {@link FileInfo}-like payload, used by both the
 * file row (the compact bubble) and the file-detail overlay (the fullscreen inspector). Extracted so the icon tint,
 * the extension badge, and the human-readable size render identically in the two places that show a file.
 */

/** Display category derived from mimeType (drives the icon tint). The backend accepts any file
 *  type (open model), so unknown MIMEs fall through to a dedicated default category. */
export type FileCategory =
  | 'pdf'
  | 'doc'
  | 'sheet'
  | 'slides'
  | 'archive'
  | 'text'
  | 'unknown';

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
  return 'unknown';
}

/** Upload-time category when only a local filename is available. Unknown extensions never inherit
 * the archive treatment; only an explicit compressed-file suffix maps to `archive`. */
export function categorizeFilename(name: string): FileCategory {
  const ext = fileExt(name).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (['doc', 'docx', 'rtf'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'sheet';
  if (['ppt', 'pptx'].includes(ext)) return 'slides';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return 'archive';
  if (['txt', 'md', 'json', 'xml', 'log'].includes(ext)) return 'text';
  return 'unknown';
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

/** Uppercased extension badge from the trusted server-sanitized filename. Icon badges are intentionally
 * capped at four characters; extension classification uses the same compact token. */
export function fileExt(name: string): string {
  const i = name.lastIndexOf('.');
  if (i < 0) return 'FILE';
  const ext = name.slice(i + 1);
  if (!/^[a-z0-9]+$/i.test(ext)) return '?';
  return ext.slice(0, 4).toUpperCase();
}

/** Human-readable playback duration: <1h → "M:SS", ≥1h → "H:MM:SS". Empty for 0 / unknown / non-finite.
 *  Used by the video/audio duration overlay on the unified media card. */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const total = Math.floor(sec);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const ss = String(s).padStart(2, '0');
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${ss}`;
  return `${m}:${ss}`;
}
