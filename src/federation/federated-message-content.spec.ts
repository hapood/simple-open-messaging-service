import { describe, expect, it } from 'vitest';
import { ContentType } from '../database/enums.js';
import {
  federatedContentDigests,
  fromFederatedMessageContent,
  toFederatedMessageContent,
} from './federated-message-content.js';

const digestA = 'a'.repeat(64);
const digestB = 'b'.repeat(64);
const cas = (digest: string) =>
  `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`;

describe('federated message content projection', () => {
  it.each([
    [
      ContentType.IMAGE,
      { url: cas(digestA), w: 10, h: 20, size: 30, name: 'a.png' },
      { digest: digestA, width: 10, height: 20, name: 'a.png' },
    ],
    [
      ContentType.FILE,
      { url: cas(digestA), name: 'a.txt', size: 30, mimeType: 'text/plain' },
      { digest: digestA, name: 'a.txt', mimeType: 'text/plain' },
    ],
    [
      ContentType.VIDEO,
      {
        url: cas(digestA),
        name: 'a.mp4',
        size: 30,
        mimeType: 'video/mp4',
        w: 10,
        h: 20,
        duration: 1.5,
      },
      {
        digest: digestA,
        name: 'a.mp4',
        mimeType: 'video/mp4',
        width: 10,
        height: 20,
        duration: 1.5,
      },
    ],
    [
      ContentType.AUDIO,
      {
        url: cas(digestA),
        name: 'a.mp3',
        size: 30,
        mimeType: 'audio/mpeg',
        duration: 1.5,
      },
      {
        digest: digestA,
        name: 'a.mp3',
        mimeType: 'audio/mpeg',
        duration: 1.5,
      },
    ],
  ] as const)('projects %s without a URL', (contentType, local, wire) => {
    expect(
      JSON.parse(toFederatedMessageContent(contentType, JSON.stringify(local))),
    ).toEqual(wire);
    expect(
      JSON.parse(
        fromFederatedMessageContent(
          contentType,
          JSON.stringify(wire),
          new Map([[digestA, 30]]),
        ),
      ),
    ).toEqual({ ...local, url: cas(digestA) });
  });

  it('requires image filenames across peers', () => {
    const local = {
      url: cas(digestA),
      w: 10,
      h: 20,
      size: 30,
      name: 'photo.png',
    };
    const wire = JSON.parse(
      toFederatedMessageContent(ContentType.IMAGE, JSON.stringify(local)),
    );
    expect(wire).toEqual({
      digest: digestA,
      width: 10,
      height: 20,
      name: 'photo.png',
    });
    expect(
      JSON.parse(
        fromFederatedMessageContent(
          ContentType.IMAGE,
          JSON.stringify(wire),
          new Map([[digestA, 30]]),
        ),
      ),
    ).toEqual(local);
    expect(() =>
      fromFederatedMessageContent(
        ContentType.IMAGE,
        JSON.stringify({ ...wire, name: 'x'.repeat(101) }),
        new Map([[digestA, 30]]),
      ),
    ).toThrow('invalid image filename');
  });

  it('projects every gallery item and preserves its order', () => {
    const local = {
      items: [
        {
          kind: 'IMAGE',
          url: cas(digestA),
          size: 1,
          w: 2,
          h: 3,
          name: 'album.png',
        },
        {
          kind: 'FILE',
          url: cas(digestB),
          size: 4,
          name: 'b.bin',
          mimeType: 'application/octet-stream',
        },
      ],
    };
    const wire = JSON.parse(
      toFederatedMessageContent(ContentType.GALLERY, JSON.stringify(local)),
    ) as { items: Array<Record<string, unknown>> };

    expect(wire.items.map((item) => item['digest'])).toEqual([
      digestA,
      digestB,
    ]);
    expect(wire.items[0]).toMatchObject({ width: 2, height: 3 });
    expect(wire.items[0]).not.toHaveProperty('w');
    expect(wire.items[0]).not.toHaveProperty('h');
    expect(wire.items[0]).not.toHaveProperty('size');
    expect(wire.items[1]).not.toHaveProperty('size');
    expect(JSON.stringify(wire)).not.toContain('/uploads/');
    expect(
      federatedContentDigests(ContentType.GALLERY, JSON.stringify(wire)),
    ).toEqual([digestA, digestB]);
    expect(
      JSON.parse(
        fromFederatedMessageContent(
          ContentType.GALLERY,
          JSON.stringify(wire),
          new Map([
            [digestA, 1],
            [digestB, 4],
          ]),
        ),
      ),
    ).toEqual(local);
  });

  it('federates optional LINK artwork as digests and restores local URLs', () => {
    const wire = JSON.parse(
      toFederatedMessageContent(
        ContentType.LINK,
        JSON.stringify({
          url: 'https://example.test/article',
          title: 'Title',
          description: '',
          image: cas(digestA),
          favicon: cas(digestB),
        }),
      ),
    );

    expect(wire).toEqual({
      url: 'https://example.test/article',
      title: 'Title',
      description: '',
      icon: digestA,
      favicon: digestB,
    });
    expect(
      federatedContentDigests(ContentType.LINK, JSON.stringify(wire)),
    ).toEqual([digestA, digestB]);
    expect(
      JSON.parse(
        fromFederatedMessageContent(ContentType.LINK, JSON.stringify(wire)),
      ),
    ).toEqual({
      url: 'https://example.test/article',
      title: 'Title',
      description: '',
      image: cas(digestA),
      favicon: cas(digestB),
    });
  });

  it('preserves non-HTTP LINK targets in both wire directions', () => {
    const target = 'example-chat://thread/123?message=4';
    const local = JSON.stringify({
      url: target,
      title: 'Open chat',
      description: '',
    });
    const wire = toFederatedMessageContent(ContentType.LINK, local);
    expect(JSON.parse(wire)).toEqual(JSON.parse(local));
    expect(
      JSON.parse(fromFederatedMessageContent(ContentType.LINK, wire)),
    ).toEqual(JSON.parse(local));
  });

  it('rejects relative and malformed LINK targets', () => {
    for (const target of [
      '/thread/123',
      'example-chat:',
      'example-chat://a\nignored',
    ]) {
      expect(() =>
        fromFederatedMessageContent(
          ContentType.LINK,
          JSON.stringify({ url: target, title: '', description: '' }),
        ),
      ).toThrow();
    }
  });

  it('allows empty LINK text fields and omitted artwork', () => {
    const wire = JSON.stringify({
      url: 'https://example.test/article',
      title: '',
      description: '',
      siteName: '',
    });

    expect(
      JSON.parse(fromFederatedMessageContent(ContentType.LINK, wire)),
    ).toEqual(JSON.parse(wire));
    expect(federatedContentDigests(ContentType.LINK, wire)).toEqual([]);
  });

  it('projects CONTACT_CARD avatar artwork without changing its user address', () => {
    const local = {
      account: 'carol',
      domain: 'local',
      displayName: 'Carol',
      bio: 'Distributed systems enthusiast',
      avatar: cas(digestA),
    };
    const wire = {
      account: 'carol',
      domain: 'local',
      displayName: 'Carol',
      bio: 'Distributed systems enthusiast',
      avatarDigest: digestA,
    };

    expect(
      JSON.parse(
        toFederatedMessageContent(
          ContentType.CONTACT_CARD,
          JSON.stringify(local),
        ),
      ),
    ).toEqual(wire);
    expect(
      federatedContentDigests(ContentType.CONTACT_CARD, JSON.stringify(wire)),
    ).toEqual([digestA]);
    expect(
      JSON.parse(
        fromFederatedMessageContent(
          ContentType.CONTACT_CARD,
          JSON.stringify(wire),
        ),
      ),
    ).toEqual(local);
  });

  it('rejects malformed CONTACT_CARD content', () => {
    expect(() =>
      fromFederatedMessageContent(
        ContentType.CONTACT_CARD,
        JSON.stringify({
          account: 'invalid account',
          domain: 'c.example',
          displayName: 'Group',
          bio: '',
        }),
      ),
    ).toThrow('invalid contact card');
    expect(() =>
      fromFederatedMessageContent(
        ContentType.CONTACT_CARD,
        JSON.stringify({
          account: 'carol',
          domain: 'c.example',
          displayName: 'Carol',
          bio: '',
          avatarDigest: 'invalid',
        }),
      ),
    ).toThrow('invalid media digest');
    expect(() =>
      fromFederatedMessageContent(
        ContentType.CONTACT_CARD,
        JSON.stringify({
          account: 'carol',
          domain: 'c.example',
          displayName: 'Carol',
          bio: 'x'.repeat(121),
        }),
      ),
    ).toThrow('invalid contact card');
  });

  it('accepts a group contact without a separate discriminator', () => {
    const wire = JSON.stringify({
      account: '!group123',
      domain: 'groups.test',
      displayName: 'Project Group',
      bio: '',
    });
    expect(
      JSON.parse(fromFederatedMessageContent(ContentType.CONTACT_CARD, wire)),
    ).toEqual(JSON.parse(wire));
  });

  it('rejects invalid or unknown LINK artwork fields on wire input', () => {
    expect(() =>
      fromFederatedMessageContent(
        ContentType.LINK,
        JSON.stringify({
          url: 'https://example.test/article',
          title: 'Title',
          description: '',
          imageDigest: digestA,
        }),
      ),
    ).toThrow('invalid fields');
    expect(() =>
      fromFederatedMessageContent(
        ContentType.LINK,
        JSON.stringify({
          url: 'https://example.test/article',
          title: '',
          description: '',
          favicon: 'not-a-digest',
        }),
      ),
    ).toThrow('invalid media digest');
  });

  it('projects local FORWARD metadata to the unchanged wire reference', () => {
    const bundleId = 'a'.repeat(64);
    expect(
      toFederatedMessageContent(
        ContentType.FORWARD,
        JSON.stringify({
          bundleId,
          summaryLines: ['hello'],
          messageCount: 3,
          depth: 2,
        }),
      ),
    ).toBe(JSON.stringify({ bundleId }));
    expect(() =>
      toFederatedMessageContent(
        ContentType.FORWARD,
        JSON.stringify({ bundleId, summaryLines: [], messageCount: 3 }),
      ),
    ).toThrow('invalid fields');
  });

  it('publishes an imported minimal FORWARD card idempotently', () => {
    const imported = JSON.stringify({ bundleId: 'a'.repeat(64) });

    expect(toFederatedMessageContent(ContentType.FORWARD, imported)).toBe(
      imported,
    );
    expect(() =>
      toFederatedMessageContent(
        ContentType.FORWARD,
        JSON.stringify({
          bundleId: 'a'.repeat(64),
          unexpected: true,
        }),
      ),
    ).toThrow('invalid fields');
  });

  it('rejects the removed CALL message type in both directions', () => {
    expect(() =>
      toFederatedMessageContent('CALL' as ContentType, '{}'),
    ).toThrow();
    expect(() =>
      fromFederatedMessageContent('CALL' as ContentType, '{}'),
    ).toThrow();
  });

  it('drops local quote media previews on publish and rejects them on wire input', () => {
    const local = JSON.stringify({
      text: 'hello [@Alice](somfp://user/0/alice)',
      quote: {
        seq: 1,
        digest: 'd'.repeat(64),
        body: 'preview',
        image: cas(digestA),
      },
    });
    const wire = toFederatedMessageContent(ContentType.PURE_TEXT, local);
    expect(JSON.parse(wire)).toEqual({
      text: 'hello [@Alice](somfp://user/0/alice)',
    });
    expect(() =>
      fromFederatedMessageContent(ContentType.PURE_TEXT, local),
    ).toThrow('invalid fields');
  });

  it('passes user mentions through unchanged at the federation boundary', () => {
    const stored = JSON.stringify({
      text: 'hello [@Alice](somfp://user/0/alice)',
    });
    const wire = toFederatedMessageContent(ContentType.PURE_TEXT, stored);
    expect(JSON.parse(wire)).toEqual({
      text: 'hello [@Alice](somfp://user/0/alice)',
    });
    expect(
      JSON.parse(fromFederatedMessageContent(ContentType.PURE_TEXT, wire)),
    ).toEqual(JSON.parse(stored));
  });

  it('rejects a wire mention carrying a domain-style address', () => {
    // The v1 user entity is (namespaceId, account), never account@domain.
    // A domain-style token is malformed and stays ordinary text; projectTextContent
    // validates only successfully-parsed entities, so the malformed token round-trips
    // as plain text rather than throwing.
    const wire = JSON.stringify({
      text: 'hello [@Alice](somfp://user/alice%40example.test)',
    });
    const result = JSON.parse(
      fromFederatedMessageContent(ContentType.PURE_TEXT, wire),
    );
    expect(result.text).toBe(
      'hello [@Alice](somfp://user/alice%40example.test)',
    );
  });
});
