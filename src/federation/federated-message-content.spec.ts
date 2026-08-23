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
      { digest: digestA, w: 10, h: 20, size: 30 },
    ],
    [
      ContentType.FILE,
      { url: cas(digestA), name: 'a.txt', size: 30, mimeType: 'text/plain' },
      { digest: digestA, name: 'a.txt', size: 30, mimeType: 'text/plain' },
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
        size: 30,
        mimeType: 'video/mp4',
        w: 10,
        h: 20,
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
        size: 30,
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
    expect(JSON.stringify(wire)).not.toContain('/uploads/');
    expect(
      federatedContentDigests(ContentType.GALLERY, JSON.stringify(wire)),
    ).toEqual([digestA, digestB]);
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
      avatar: cas(digestA),
    };
    const wire = {
      account: 'carol',
      domain: 'local.test',
      displayName: 'Carol',
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
          avatarDigest: 'invalid',
        }),
        'local.test',
      ),
    ).toThrow('invalid media digest');
  });

  it('accepts a group contact without a separate discriminator', () => {
    const wire = JSON.stringify({
      account: '!group123',
      domain: 'groups.test',
      displayName: 'Project Group',
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

  it('drops local quote media previews on publish and rejects them on wire input', () => {
    const local = JSON.stringify({
      text: 'hello [@Alice](socfp://user/alice%40example.test)',
      quote: { seq: 1, body: 'preview', image: cas(digestA) },
    });
    const wire = toFederatedMessageContent(
      ContentType.PURE_TEXT,
      local,
      'local.test',
    );
    expect(JSON.parse(wire)).toEqual({
      text: 'hello [@Alice](socfp://user/alice%40example.test)',
    });
    expect(() =>
      fromFederatedMessageContent(ContentType.PURE_TEXT, local, 'local.test'),
    ).toThrow('invalid fields');
  });

  it('maps the local mention domain only at the federation boundary', () => {
    const stored = JSON.stringify({
      text: 'hello [@Alice](socfp://user/alice%40local)',
    });
    const wire = toFederatedMessageContent(
      ContentType.PURE_TEXT,
      stored,
      'local.test',
    );
    expect(JSON.parse(wire)).toEqual({
      text: 'hello [@Alice](socfp://user/alice%40local.test)',
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
      text: `hello [@Alice](socfp://user/${encodeURIComponent(address)})`,
    });
    expect(() =>
      fromFederatedMessageContent(ContentType.PURE_TEXT, wire, 'local.test'),
    ).toThrow('valid full address');
  });
});
