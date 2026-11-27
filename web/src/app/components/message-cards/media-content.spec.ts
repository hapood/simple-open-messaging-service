import { describe, expect, it } from 'vitest';
import {
  contextualLinkContent,
  contextualMediaUrl,
  parseGalleryContent,
  parseAudioContent,
  parseFileContent,
  parseImageContent,
  parseVideoContent,
} from './media-content';

describe('message media content', () => {
  it('binds a canonical local CAS URL to its message authorization context', () => {
    const bare = `/uploads/msg-assets/0e/8c/${'a'.repeat(64)}`;

    expect(contextualMediaUrl({ url: bare }, 1, 4)).toBe(
      `${bare}?threadId=1&seq=4`,
    );
    expect(contextualMediaUrl({ url: 'https://peer.test/audio' }, 1, 4)).toBe(
      'https://peer.test/audio',
    );
  });

  it('binds LINK artwork to its carrier without changing the page URL', () => {
    const image = `/uploads/msg-assets/aa/aa/${'a'.repeat(64)}`;
    expect(
      JSON.parse(
        contextualLinkContent(
          JSON.stringify({
            url: 'https://example.test',
            image,
            favicon: image,
          }),
          3,
          8,
        ),
      ),
    ).toEqual({
      url: 'https://example.test',
      image: `${image}?threadId=3&seq=8`,
      favicon: `${image}?threadId=3&seq=8`,
    });
  });

  it('parses a forwarded gallery through a caller-provided digest URL resolver', () => {
    // A localized bundle carries the canonical CAS path per item; the digest is
    // its identity and the snapshot resolver derives the loadable URL from it.
    const imageDigest = 'a'.repeat(64);
    const videoDigest = 'b'.repeat(64);
    const casUrl = (digest: string) =>
      `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;
    const content = JSON.stringify({
      items: [
        {
          kind: 'IMAGE',
          url: casUrl(imageDigest),
          name: 'photo.jpg',
          size: 88275,
          mimeType: 'image/jpeg',
          w: 378,
          h: 671,
        },
        {
          kind: 'VIDEO',
          url: casUrl(videoDigest),
          name: 'clip.mp4',
          size: 204800,
          mimeType: 'video/mp4',
          w: 640,
          h: 360,
          duration: 12,
        },
      ],
    });

    const media = parseGalleryContent(
      content,
      (item) => `/snapshot/${String(item['url']).slice(-64)}`,
    );

    expect(media).toEqual([
      expect.objectContaining({
        kind: 'image',
        src: `/snapshot/${imageDigest}`,
        name: 'photo.jpg',
        w: 378,
        h: 671,
        size: 88275,
      }),
      expect.objectContaining({
        kind: 'video',
        src: `/snapshot/${videoDigest}`,
        name: 'clip.mp4',
        w: 640,
        h: 360,
        duration: 12,
      }),
    ]);
  });

  it('projects only the metadata owned by each resource kind', () => {
    const base = {
      url: '/uploads/resource',
      name: 'resource',
      size: 1024,
      mimeType: 'application/octet-stream',
    };
    // Every resource carries its owning message coordinate; a standalone parse
    // has none and reports zero.
    const metadata = {
      msgId: 0,
      src: base.url,
      name: base.name,
      size: base.size,
      mimeType: base.mimeType,
      senderName: null,
      sentAt: null,
    };
    expect(
      parseImageContent(JSON.stringify({ ...base, w: 640, h: 480 })),
    ).toEqual({ ...metadata, kind: 'image', w: 640, h: 480 });
    expect(
      parseVideoContent(
        JSON.stringify({ ...base, w: 640, h: 480, duration: 12 }),
      ),
    ).toEqual({ ...metadata, kind: 'video', w: 640, h: 480, duration: 12 });
    expect(
      parseAudioContent(JSON.stringify({ ...base, duration: 12 })),
    ).toEqual({ ...metadata, kind: 'audio', duration: 12 });
    expect(parseFileContent(JSON.stringify(base))).toEqual(base);
    expect(
      parseGalleryContent(
        JSON.stringify({ items: [{ ...base, kind: 'FILE' }] }),
      ),
    ).toEqual([{ ...metadata, kind: 'file' }]);
    expect(
      parseGalleryContent(
        JSON.stringify({ items: [{ ...base, kind: 'FILE' }] }),
        undefined,
        7,
      ),
    ).toEqual([{ ...metadata, msgId: 7, kind: 'file' }]);
  });

  it('surfaces malformed content instead of returning an empty gallery', () => {
    expect(() => parseGalleryContent('{')).toThrow();
    expect(() =>
      parseGalleryContent(JSON.stringify({ items: [null] })),
    ).toThrow();
    expect(() =>
      parseGalleryContent(JSON.stringify({ items: [{ kind: 'UNKNOWN' }] })),
    ).toThrow('Unsupported gallery resource');
    // A bare digest is wire identity, not a server-authored resource reference.
    expect(() =>
      parseGalleryContent(
        JSON.stringify({ items: [{ kind: 'IMAGE', digest: 'a'.repeat(64) }] }),
      ),
    ).toThrow('Invalid gallery.image.url');
  });
});
