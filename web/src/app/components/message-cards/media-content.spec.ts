import { describe, expect, it } from 'vitest';
import { contextualMediaUrl, parseGalleryContent } from './media-content';

describe('message media content', () => {
  it('repairs a bare local CAS URL with its message authorization context', () => {
    const bare = `/uploads/msg-assets/0e/8c/${'a'.repeat(64)}`;

    expect(contextualMediaUrl({ url: bare }, 1, 4)).toBe(
      `${bare}?threadId=1&seq=4`,
    );
    expect(contextualMediaUrl({ url: `${bare}?threadId=2&seq=7` }, 1, 4)).toBe(
      `${bare}?threadId=2&seq=7`,
    );
    expect(contextualMediaUrl({ url: 'https://peer.test/audio' }, 1, 4)).toBe(
      'https://peer.test/audio',
    );
  });

  it('parses a forwarded gallery through a caller-provided digest URL resolver', () => {
    const content = JSON.stringify({
      items: [
        {
          kind: 'IMAGE',
          digest: 'a'.repeat(64),
          w: 378,
          h: 671,
          size: 88275,
        },
        {
          kind: 'VIDEO',
          digest: 'b'.repeat(64),
          w: 640,
          h: 360,
          duration: 12,
        },
      ],
    });

    const media = parseGalleryContent(content, (item) =>
      typeof item['digest'] === 'string' ? `/snapshot/${item['digest']}` : '',
    );

    expect(media).toEqual([
      expect.objectContaining({
        kind: 'image',
        src: `/snapshot/${'a'.repeat(64)}`,
        w: 378,
        h: 671,
        size: 88275,
      }),
      expect.objectContaining({
        kind: 'video',
        src: `/snapshot/${'b'.repeat(64)}`,
        w: 640,
        h: 360,
        duration: 12,
      }),
    ]);
  });

  it('keeps malformed gallery entries isolated', () => {
    expect(
      parseGalleryContent(JSON.stringify({ items: [null, { kind: 'IMAGE' }] })),
    ).toEqual([]);
  });
});
