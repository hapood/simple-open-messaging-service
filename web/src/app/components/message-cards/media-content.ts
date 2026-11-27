import type {
  AlbumMedia,
  ImageMedia,
  VideoMedia,
  AudioMedia,
  FileInfo,
  AuthoredContentType,
  AuthoredMessageContent,
} from './chat-item';

/** Project content and attribution together so attachment presence follows contentType. */
export function projectMessageContent(
  contentType: AuthoredContentType,
  content: string,
  attribution: { msgId: number; senderName: string; sentAt: number },
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): AuthoredMessageContent {
  let images: AlbumMedia[];
  switch (contentType) {
    case 'FILE':
      return {
        contentType,
        images: null,
        file: parseFileContent(content, resolveUrl),
      };
    case 'IMAGE':
      images = [parseImageContent(content, resolveUrl, attribution.msgId)];
      break;
    case 'VIDEO':
      images = [parseVideoContent(content, resolveUrl, attribution.msgId)];
      break;
    case 'AUDIO':
      images = [parseAudioContent(content, resolveUrl, attribution.msgId)];
      break;
    case 'GALLERY':
      images = parseGalleryContent(content, resolveUrl, attribution.msgId);
      break;
    default:
      return { contentType, images: null, file: null };
  }
  return {
    contentType,
    images: images.map((resource) => ({ ...resource, ...attribution })),
    file: null,
  };
}

export type MediaUrlResolver = (item: Record<string, unknown>) => string;
const defaultUrlResolver: MediaUrlResolver = (item) => item['url'] as string;

const BARE_CAS_URL_RE =
  /^\/uploads\/msg-assets\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/;

/** Bind a canonical CAS URL to the message that authorizes its download. */
export function contextualMediaUrl(
  item: Record<string, unknown>,
  threadId: number,
  seq: number,
): string {
  const url = item['url'] as string;
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
  const item = JSON.parse(content) as Record<string, unknown>;
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

/** Server-authored content contract. This projection does not repair or discard protocol data. */
type ResourceContent = Record<string, unknown> & {
  url: string;
  name: string;
  size: number;
  mimeType: string;
};
type ImageContent = ResourceContent & { w: number; h: number };
type VideoContent = ImageContent & { duration: number };
type AudioContent = ResourceContent & { duration: number };
type GalleryEntry =
  | (ImageContent & { kind: 'IMAGE' })
  | (VideoContent & { kind: 'VIDEO' })
  | (AudioContent & { kind: 'AUDIO' })
  | (ResourceContent & { kind: 'FILE' });

function requireObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`Invalid ${label} content`);
  return value as Record<string, unknown>;
}
function requireString(
  obj: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = obj[key];
  if (typeof value !== 'string')
    throw new Error(`Invalid ${label}.${key}`);
  return value;
}
function requireNumber(
  obj: Record<string, unknown>,
  key: string,
  label: string,
): number {
  const value = obj[key];
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`Invalid ${label}.${key}`);
  return value;
}
function requireResource(value: unknown, label: string): ResourceContent {
  const obj = requireObject(value, label);
  return {
    ...obj,
    url: requireString(obj, 'url', label),
    name: requireString(obj, 'name', label),
    size: requireNumber(obj, 'size', label),
    mimeType: requireString(obj, 'mimeType', label),
  };
}
function requireImage(value: unknown, label = 'image'): ImageContent {
  const base = requireResource(value, label);
  return {
    ...base,
    w: requireNumber(base, 'w', label),
    h: requireNumber(base, 'h', label),
  };
}
function requireVideo(value: unknown, label = 'video'): VideoContent {
  const base = requireImage(value, label);
  return {
    ...base,
    duration: requireNumber(base, 'duration', label),
  };
}
function requireAudio(value: unknown, label = 'audio'): AudioContent {
  const base = requireResource(value, label);
  return {
    ...base,
    duration: requireNumber(base, 'duration', label),
  };
}

function metadata(
  item: ResourceContent,
  resolveUrl: MediaUrlResolver,
  msgId: number,
) {
  return {
    msgId,
    src: resolveUrl(item),
    name: item.name,
    size: item.size,
    mimeType: item.mimeType,
    senderName: null,
    sentAt: null,
  };
}
function image(
  item: ImageContent,
  resolveUrl: MediaUrlResolver,
  msgId: number,
): ImageMedia {
  return {
    ...metadata(item, resolveUrl, msgId),
    kind: 'image',
    w: item.w,
    h: item.h,
  };
}
function video(
  item: VideoContent,
  resolveUrl: MediaUrlResolver,
  msgId: number,
): VideoMedia {
  return {
    ...metadata(item, resolveUrl, msgId),
    kind: 'video',
    w: item.w,
    h: item.h,
    duration: item.duration,
  };
}
function audio(
  item: AudioContent,
  resolveUrl: MediaUrlResolver,
  msgId: number,
): AudioMedia {
  return {
    ...metadata(item, resolveUrl, msgId),
    kind: 'audio',
    duration: item.duration,
  };
}

export function parseImageContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
  msgId = 0,
): ImageMedia {
  return image(requireImage(JSON.parse(content)), resolveUrl, msgId);
}
export function parseVideoContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
  msgId = 0,
): VideoMedia {
  return video(requireVideo(JSON.parse(content)), resolveUrl, msgId);
}
export function parseAudioContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
  msgId = 0,
): AudioMedia {
  return audio(requireAudio(JSON.parse(content)), resolveUrl, msgId);
}
export function parseGalleryContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
  msgId = 0,
): AlbumMedia[] {
  const gallery = requireObject(JSON.parse(content), 'gallery');
  if (!Array.isArray(gallery['items']))
    throw new Error('Invalid gallery.items');
  return gallery['items'].map((raw) => {
    const obj = requireObject(raw, 'gallery.item');
    const kind = obj['kind'];
    switch (kind) {
      case 'IMAGE':
        return image(requireImage(obj, 'gallery.image'), resolveUrl, msgId);
      case 'VIDEO':
        return video(requireVideo(obj, 'gallery.video'), resolveUrl, msgId);
      case 'AUDIO':
        return audio(requireAudio(obj, 'gallery.audio'), resolveUrl, msgId);
      case 'FILE':
        return {
          ...metadata(
            requireResource(obj, 'gallery.file'),
            resolveUrl,
            msgId,
          ),
          kind: 'file',
        };
      default:
        throw new Error(`Unsupported gallery resource: ${JSON.stringify(obj)}`);
    }
  });
}

export function parseFileContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): FileInfo {
  const item = requireResource(JSON.parse(content), 'file');
  return {
    url: resolveUrl(item),
    name: item.name,
    size: item.size,
    mimeType: item.mimeType,
  };
}
