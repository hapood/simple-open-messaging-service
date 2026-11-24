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
      images = [parseImageContent(content, resolveUrl)];
      break;
    case 'VIDEO':
      images = [parseVideoContent(content, resolveUrl)];
      break;
    case 'AUDIO':
      images = [parseAudioContent(content, resolveUrl)];
      break;
    case 'GALLERY':
      images = parseGalleryContent(content, resolveUrl);
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

function metadata(item: ResourceContent, resolveUrl: MediaUrlResolver) {
  return {
    src: resolveUrl(item),
    name: item.name,
    size: item.size,
    mimeType: item.mimeType,
    senderName: null,
    sentAt: null,
  };
}
function image(item: ImageContent, resolveUrl: MediaUrlResolver): ImageMedia {
  return { ...metadata(item, resolveUrl), kind: 'image', w: item.w, h: item.h };
}
function video(item: VideoContent, resolveUrl: MediaUrlResolver): VideoMedia {
  return {
    ...metadata(item, resolveUrl),
    kind: 'video',
    w: item.w,
    h: item.h,
    duration: item.duration,
  };
}
function audio(item: AudioContent, resolveUrl: MediaUrlResolver): AudioMedia {
  return {
    ...metadata(item, resolveUrl),
    kind: 'audio',
    duration: item.duration,
  };
}

export function parseImageContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): ImageMedia {
  return image(JSON.parse(content) as ImageContent, resolveUrl);
}
export function parseVideoContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): VideoMedia {
  return video(JSON.parse(content) as VideoContent, resolveUrl);
}
export function parseAudioContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): AudioMedia {
  return audio(JSON.parse(content) as AudioContent, resolveUrl);
}
export function parseGalleryContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): AlbumMedia[] {
  const gallery = JSON.parse(content) as { items: GalleryEntry[] };
  return gallery.items.map((item) => {
    switch (item.kind) {
      case 'IMAGE':
        return image(item, resolveUrl);
      case 'VIDEO':
        return video(item, resolveUrl);
      case 'AUDIO':
        return audio(item, resolveUrl);
      case 'FILE':
        return { ...metadata(item, resolveUrl), kind: 'file' };
      default:
        return unsupportedKind(item);
    }
  });
}
function unsupportedKind(item: never): never {
  throw new Error(`Unsupported gallery resource: ${JSON.stringify(item)}`);
}

export function parseFileContent(
  content: string,
  resolveUrl: MediaUrlResolver = defaultUrlResolver,
): FileInfo {
  const item = JSON.parse(content) as ResourceContent & {
    name: string;
    size: number;
    mimeType: string;
  };
  return {
    url: resolveUrl(item),
    name: item.name,
    size: item.size,
    mimeType: item.mimeType,
  };
}
