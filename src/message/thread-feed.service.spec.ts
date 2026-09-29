import { describe, expect, it, vi } from 'vitest';
import { ThreadFeedService } from './thread-feed.service.js';
import { mentionsAccount } from './thread-feed-head.writer.js';

describe('thread feed database previews', () => {
  function setup() {
    const read = vi.fn(async (_tx, _accountId, _threadId, take) =>
      [1, 2, 3].slice(-take).map((seq) => ({
        seq,
        createdAt: '2026-09-08T00:00:0' + (seq - 1) + 'Z',
        creatorAccount: 'peer',
        creatorDomain: 'local',
        profileNamespaceId: 0,
        profileRev: seq,
        isDeleted: seq !== 1,
        deletionType:
          seq === 2
            ? 'USER_RETRACTION'
            : seq === 3
              ? 'MODERATION_REMOVAL'
              : null,
        contentType: 'PURE_TEXT',
        content: '{"text":"hello"}',
      })),
    );
    const execute = vi.fn().mockImplementation(async () =>
      execute.mock.calls.length % 2 === 1
        ? { rows: [{ threadFeedEndId: 10 }] }
        : {
            rows: [
              {
                threadId: 7,
                threadFeedId: 10,
                type: 'P2P',
                authorityNamespaceId: 0,
                conversationState: 'ACTIVE',
                blocked: false,
                role: null,
                profileAccount: 'peer',
                profileDomain: 'local',
                profileNamespaceId: 0,
                profileRev: 3,
                threadProfileRev: 3,
                profileSourceId: 12,
                messageEndSeq: 4,
                tombstoneEndSeq: 2,
                groupMetaFeedEndId: 4,
                announcementReadFeedId: 2,
                unreadCount: 1,
                lastReadSeq: 0,
                lastMentionSeq: null,
              },
            ],
          },
    );
    const db = {
      db: { transaction: (run: (tx: unknown) => unknown) => run({ execute }) },
    };
    const service = new ThreadFeedService(db as never);
    Object.assign(service, { previews: { limit: 3, readInTx: read } });
    return { service, read, execute };
  }

  it('omits previews by default and never queries previews for zero', async () => {
    const { service, read } = setup();
    const result = await service.queryThreadFeedDelta(1, { after: 0 });
    expect(result.items[0]).not.toHaveProperty('previews');
    expect(result.items[0]).not.toHaveProperty('establishedAt');
    expect(result.items[0]).toMatchObject({
      groupMetaFeedEndId: '4',
      announcementReadFeedId: 2,
      type: 'P2P',
      blocked: false,
      profileSourceId: 12,
      profile: { account: 'peer', domain: 'local', namespaceId: 0, profileRev: 3 },
    });
    expect(read).not.toHaveBeenCalled();
  });

  it('returns the latest other-sender entries, with no deleted text or avatars', async () => {
    const { service, execute } = setup();
    const result = await service.queryThreadFeedDelta(1, {
      after: 0,
      previewCount: 3,
    });
    expect(result.items[0].previews).toEqual([
      {
        seq: 1,
        createdAt: '2026-09-08T00:00:00.000Z',
        sender: { account: 'peer', domain: 'local', namespaceId: 0, profileRev: 1 },
        status: 'LIVE',
        text: 'hello',
      },
      {
        seq: 2,
        createdAt: '2026-09-08T00:00:01.000Z',
        sender: { account: 'peer', domain: 'local', namespaceId: 0, profileRev: 2 },
        status: 'USER_RETRACTION',
      },
      {
        seq: 3,
        createdAt: '2026-09-08T00:00:02.000Z',
        sender: { account: 'peer', domain: 'local', namespaceId: 0, profileRev: 3 },
        status: 'MODERATION_REMOVAL',
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('renders mention entities as display text in previews, not wire markup', async () => {
    const { service, read } = setup();
    read.mockImplementation(async () => [
      {
        seq: 3,
        createdAt: '2026-09-08T00:00:02Z',
        creatorAccount: 'peer',
        creatorDomain: 'local',
        profileNamespaceId: 0,
        profileRev: 3,
        isDeleted: false,
        deletionType: null,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({
          text: '[@Reader](somfp://user/reader) hi [@All](somfp://audience/all)',
        }),
      },
    ]);
    const result = await service.queryThreadFeedDelta(1, {
      after: 0,
      previewCount: 1,
    });
    expect(result.items[0].previews?.[0]?.text).toBe('@Reader hi @All');
  });

  it('takes one newest entry and rejects counts above the configured limit', async () => {
    const { service, execute } = setup();
    const result = await service.queryThreadFeedDelta(1, {
      after: 0,
      previewCount: 1,
    });
    expect(result.items[0].previews?.map((item) => item.seq)).toEqual([3]);
    for (const previewCount of [-1, 1.5, 4])
      await expect(
        service.queryThreadFeedDelta(1, { after: 0, previewCount }),
      ).rejects.toMatchObject({ bizCode: 10000 });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('thread mention semantics', () => {
  it('recognizes user and audience entities but not escaped text or another account', () => {
    const content = (text: string) => JSON.stringify({ text });
    expect(
      mentionsAccount(content('[@Reader](somfp://user/reader)'), 'reader'),
    ).toBe(true);
    expect(
      mentionsAccount(content('[@All](somfp://audience/all)'), 'reader'),
    ).toBe(true);
    expect(
      mentionsAccount(content('[@Other](somfp://user/other)'), 'reader'),
    ).toBe(false);
    expect(
      mentionsAccount(
        content(String.raw`\[@Reader](somfp://user/reader)`),
        'reader',
      ),
    ).toBe(false);
    expect(mentionsAccount(content('plain text'), 'reader')).toBe(false);
  });

  it('matches the production full-address entity forms issued by clients', () => {
    const content = (text: string) => JSON.stringify({ text });
    // The composer serializes chips as full SOMFP addresses: local members as
    // account@local, federated members as account@home-domain.
    expect(
      mentionsAccount(
        content('[@Reader](somfp://user/reader%40local)'),
        'reader',
      ),
    ).toBe(true);
    expect(
      mentionsAccount(
        content('[@Reader](somfp://user/reader%40bravo.test)'),
        'reader',
        'bravo.test',
      ),
    ).toBe(true);
    // A same-named account on another node must not badge this node's user.
    expect(
      mentionsAccount(
        content('[@Reader](somfp://user/reader%40bravo.test)'),
        'reader',
        'alpha.test',
      ),
    ).toBe(false);
    expect(
      mentionsAccount(
        content('[@Other](somfp://user/other%40local)'),
        'reader',
        'bravo.test',
      ),
    ).toBe(false);
  });
});
