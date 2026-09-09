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
      { url: `${cas(digestA)}?threadId=4&seq=7`, w: 10, h: 20, size: 30 },
      { digest: digestA, width: 10, height: 20 },
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
      JSON.parse(
        toFederatedMessageContent(
          contentType,
          JSON.stringify(local),
          'local.test',
        ),
      ),
    ).toEqual(wire);
    expect(
      JSON.parse(
        fromFederatedMessageContent(
          contentType,
          JSON.stringify(wire),
          'local.test',
          new Map([[digestA, 30]]),
        ),
      ),
    ).toEqual({ ...local, url: cas(digestA) });
  });

  it('projects every gallery item and preserves its order', () => {
    const local = {
      items: [
        { kind: 'IMAGE', url: cas(digestA), size: 1, w: 2, h: 3 },
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
      toFederatedMessageContent(
        ContentType.GALLERY,
        JSON.stringify(local),
        'local.test',
      ),
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
          'local.test',
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
        'local.test',
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
        fromFederatedMessageContent(
          ContentType.LINK,
          JSON.stringify(wire),
          'local.test',
        ),
      ),
    ).toEqual({
      url: 'https://example.test/article',
      title: 'Title',
      description: '',
      image: cas(digestA),
      favicon: cas(digestB),
    });
  });

  it('allows empty LINK text fields and omitted artwork', () => {
    const wire = JSON.stringify({
      url: 'https://example.test/article',
      title: '',
      description: '',
      siteName: '',
    });

    expect(
      JSON.parse(
        fromFederatedMessageContent(ContentType.LINK, wire, 'local.test'),
      ),
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
      domain: 'local.test',
      displayName: 'Carol',
      bio: 'Distributed systems enthusiast',
      avatarDigest: digestA,
    };

    expect(
      JSON.parse(
        toFederatedMessageContent(
          ContentType.CONTACT_CARD,
          JSON.stringify(local),
          'local.test',
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
          'local.test',
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
        'local.test',
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
        'local.test',
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
        'local.test',
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
      JSON.parse(
        fromFederatedMessageContent(
          ContentType.CONTACT_CARD,
          wire,
          'local.test',
        ),
      ),
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
        'local.test',
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
        'local.test',
      ),
    ).toThrow('invalid media digest');
  });

  it('publishes an imported minimal FORWARD card idempotently', () => {
    const imported = JSON.stringify({ bundleId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' });

    expect(
      toFederatedMessageContent(ContentType.FORWARD, imported, 'local.test'),
    ).toBe(imported);
    expect(() =>
      toFederatedMessageContent(
        ContentType.FORWARD,
        JSON.stringify({
          bundleId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
          unexpected: true,
        }),
        'local.test',
      ),
    ).toThrow('invalid fields');
  });

  it('rejects the removed CALL message type in both directions', () => {
    expect(() =>
      toFederatedMessageContent('CALL' as ContentType, '{}', 'local.test'),
    ).toThrow();
    expect(() =>
      fromFederatedMessageContent('CALL' as ContentType, '{}', 'local.test'),
    ).toThrow();
  });

  it('drops local quote media previews on publish and rejects them on wire input', () => {
    const local = JSON.stringify({
      text: 'hello [@Alice](somfp://user/alice%40example.test)',
      quote: { seq: 1, body: 'preview', image: cas(digestA) },
    });
    const wire = toFederatedMessageContent(
      ContentType.PURE_TEXT,
      local,
      'local.test',
    );
    expect(JSON.parse(wire)).toEqual({
      text: 'hello [@Alice](somfp://user/alice%40example.test)',
    });
    expect(() =>
      fromFederatedMessageContent(ContentType.PURE_TEXT, local, 'local.test'),
    ).toThrow('invalid fields');
  });

  it('maps the local mention domain only at the federation boundary', () => {
    const stored = JSON.stringify({
      text: 'hello [@Alice](somfp://user/alice%40local)',
    });
    const wire = toFederatedMessageContent(
      ContentType.PURE_TEXT,
      stored,
      'local.test',
    );
    expect(JSON.parse(wire)).toEqual({
      text: 'hello [@Alice](somfp://user/alice%40local.test)',
    });
    expect(
      JSON.parse(
        fromFederatedMessageContent(ContentType.PURE_TEXT, wire, 'local.test'),
      ),
    ).toEqual(JSON.parse(stored));
  });

  it.each([
    'alice',
    'Alice@example.test',
    'alice@@example.test',
    'alice@bad_domain',
    'alice@local',
    'alice@printer.local',
  ])('rejects invalid wire mention address %s', (address) => {
    const wire = JSON.stringify({
      text: `hello [@Alice](somfp://user/${encodeURIComponent(address)})`,
    });
    expect(() =>
      fromFederatedMessageContent(ContentType.PURE_TEXT, wire, 'local.test'),
    ).toThrow('valid full address');
  });
});
