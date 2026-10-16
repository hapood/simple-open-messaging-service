import type { AlbumMedia, FileInfo } from './chat-item';
import { VOICE_BAR_H, VOICE_BAR_W } from './media-row/layout';

export type MediaUrlResolver = (item: Record<string, unknown>) => string;

const defaultUrlResolver: MediaUrlResolver = (item) =>
  typeof item['url'] === 'string' ? item['url'] : '';

const BARE_CAS_URL_RE =
  /^\/uploads\/msg-assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

/** Bind a canonical CAS URL to the message that authorizes its download. */
export function contextualMediaUrl(
  item: Record<string, unknown>,
  threadId: number,
  seq: number,
): string {
  const url = typeof item['url'] === 'string' ? item['url'] : '';
  return BARE_CAS_URL_RE.test(url)
    ? `${url}?threadId=${threadId}&seq=${seq}`
    : url;
}

/** LINK artwork shares the same carrier authorization as ordinary attachments. */
export function contextualLinkContent(
  content: string,
  threadId: number,
  seq: number,
): string {
  const item = parseRecord(content);
  if (!item) return content;
  return JSON.stringify({
    ...item,
    ...(typeof item['image'] === 'string'
      ? { image: contextualMediaUrl({ url: item['image'] }, threadId, seq) }
      : {}),
    ...(typeof item['favicon'] === 'string'
      ? { favicon: contextualMediaUrl({ url: item['favicon'] }, threadId, seq) }
      : {}),
  });
}

export function parseImageContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): AlbumMedia {
  const item = parseRecord(content);
  return {
    kind: 'image',
    src: item ? resolveUrl(item) : '',
    w: Number(item?.['w']) || 0,
    h: Number(item?.['h']) || 0,
    size: Number(item?.['size']) || 0,
  };
}

export function parseVideoContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): AlbumMedia | null {
  return parseSingleMedia('video', content, resolveUrl);
}

export function parseAudioContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): AlbumMedia | null {
  return parseSingleMedia('audio', content, resolveUrl);
}

export function parseGalleryContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): AlbumMedia[] {
  const parsed = parseRecord(content);
  if (!Array.isArray(parsed?.['items'])) return [];
  return parsed['items'].flatMap((value): AlbumMedia[] => {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      return [];
    const item = value as Record<string, unknown>;
    const kind = String(item['kind'] ?? '').toLowerCase();
    if (!isMediaKind(kind)) return [];
    const src = resolveUrl(item);
    if (!src) return [];
    return [toAlbumImage(kind, item, src)];
  });
}

export function parseFileContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): FileInfo | null {
  const item = parseRecord(content);
  if (!item) return null;
  const url = resolveUrl(item);
  if (!url) return null;
  return {
    url,
    name: String(item['name'] ?? 'file'),
    size: Number(item['size']) || 0,
    mimeType: String(item['mimeType'] ?? ''),
  };
}

function parseSingleMedia(
  kind: 'video' | 'audio',
  content: string,
  resolveUrl: MediaUrlResolver,
): AlbumMedia | null {
  const item = parseRecord(content);
  if (!item) return null;
  const src = resolveUrl(item);
  return src ? toAlbumImage(kind, item, src) : null;
}

function toAlbumImage(
  kind: AlbumMedia['kind'],
  item: Record<string, unknown>,
  src: string,
): AlbumMedia {
  return {
    kind,
    src,
    w: kind === 'audio' ? VOICE_BAR_W : Number(item['w']) || 0,
    h: kind === 'audio' ? VOICE_BAR_H : Number(item['h']) || 0,
    size: Number(item['size']) || 0,
    duration: Number(item['duration']) || 0,
    name: typeof item['name'] === 'string' ? item['name'] : '',
    mimeType:
      typeof item['mimeType'] === 'string' ? item['mimeType'] : undefined,
  };
}

function parseRecord(content: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(content);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function isMediaKind(value: string): value is AlbumMedia['kind'] {
  return ['image', 'video', 'audio', 'file'].includes(value);
}
