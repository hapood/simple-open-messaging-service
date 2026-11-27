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
                publisherNamespaceId: 0,
                profileAccount: 'peer',
                profileRev: 3,
                threadProfileRev: 3,
                profileSourceId: 12,
                messageEndSeq: 4,
                authorAccount: 'reader',
                authorNamespaceId: 0,
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
    const transaction = vi.fn((run: (tx: unknown) => unknown) => run({ execute }));
    const db = { db: { transaction } };
    const service = new ThreadFeedService(db as never);
    Object.assign(service, { previews: { limit: 3, readInTx: read } });
    return { service, read, execute, transaction };
  }

  it('omits previews by default and never queries previews for zero', async () => {
    const { service, read } = setup();
    const result = await service.queryThreadFeedDelta(1, { after: 0 });
    expect(result.items[0]).not.toHaveProperty('previews');
    expect(result.items[0]).not.toHaveProperty('establishedAt');
    expect(result.items[0]).toMatchObject({
      announcementReadFeedId: 2,
      type: 'P2P',
      blocked: false,
      profileSourceId: 12,
      profileAccount: 'peer',
      publisherNamespaceId: 0,
      profileRev: 3,
      author: { account: 'reader', namespaceId: 0 },
    });
    expect(result.items[0]).not.toHaveProperty('authorAccount');
    expect(result.items[0]).not.toHaveProperty('authorNamespaceId');
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
        sender: { account: 'peer', profileNamespaceId: 0, profileRev: 1 },
        status: 'LIVE',
        text: 'hello',
      },
      {
        seq: 2,
        createdAt: '2026-09-08T00:00:01.000Z',
        sender: { account: 'peer', profileNamespaceId: 0, profileRev: 2 },
        status: 'USER_RETRACTION',
      },
      {
        seq: 3,
        createdAt: '2026-09-08T00:00:02.000Z',
        sender: { account: 'peer', profileNamespaceId: 0, profileRev: 3 },
        status: 'MODERATION_REMOVAL',
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('preserves sender profile coordinates in the publisher space without domains', async () => {
    const { service, read, execute } = setup();
    execute
      .mockResolvedValueOnce({ rows: [{ threadFeedEndId: 10 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            threadId: 7,
            threadFeedId: 10,
            type: 'GROUP',
            publisherNamespaceId: 7,
            profileAccount: '!group',
            profileRev: 3,
            messageEndSeq: 8,
            authorAccount: 'author',
            authorNamespaceId: 12,
            groupMetaFeedEndId: null,
          },
        ],
      });
    read.mockResolvedValueOnce(
      [0, 7].map((profileNamespaceId) => ({
        seq: profileNamespaceId + 1,
        createdAt: '2026-09-08T00:00:00Z',
        creatorAccount: 'peer',
        profileNamespaceId,
        profileRev: 3,
        isDeleted: false,
        deletionType: null,
        contentType: 'PURE_TEXT',
        content: '{"text":"hello"}',
      })),
    );

    const result = await service.queryThreadFeedDelta(1, {
      after: 0,
      previewCount: 2,
    });
    expect(result.items[0].publisherNamespaceId).toBe(7);
    expect(result.items[0].author).toEqual({ account: 'author', namespaceId: 12 });
    expect(result.items[0]).not.toHaveProperty('domain');
    expect(result.items[0].previews?.map((preview) => preview.sender)).toEqual([
      { account: 'peer', profileNamespaceId: 0, profileRev: 3 },
      { account: 'peer', profileNamespaceId: 7, profileRev: 3 },
    ]);
  });

  it('omits author at zero and reads head author in the same read-only snapshot', async () => {
    const { service, execute, transaction } = setup();
    execute.mockResolvedValueOnce({ rows: [{ threadFeedEndId: 10 }] })
      .mockResolvedValueOnce({ rows: [{
        threadId: 7, threadFeedId: 10, messageEndSeq: 0,
        authorAccount: null, authorNamespaceId: null,
      }] });
    const result = await service.queryThreadFeedDelta(1, { after: 0 });
    expect(result.items[0]).not.toHaveProperty('author');
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'repeatable read', accessMode: 'read only',
    });
  });

  it('returns the system author rather than filtering it or falling back to a peer', async () => {
    const { service, execute } = setup();
    execute.mockResolvedValueOnce({ rows: [{ threadFeedEndId: 10 }] })
      .mockResolvedValueOnce({ rows: [{
        threadId: 7, threadFeedId: 10, messageEndSeq: 3,
        authorAccount: '$system', authorNamespaceId: 0,
      }] });
    const result = await service.queryThreadFeedDelta(1, { after: 0 });
    expect(result.items[0].author).toEqual({ account: '$system', namespaceId: 0 });
  });

  it('rejects a nonzero head whose exact author is missing', async () => {
    const { service, execute } = setup();
    execute.mockResolvedValueOnce({ rows: [{ threadFeedEndId: 10 }] })
      .mockResolvedValueOnce({ rows: [{
        threadId: 7, threadFeedId: 10, messageEndSeq: 4,
        authorAccount: null, authorNamespaceId: null,
      }] });
    await expect(service.queryThreadFeedDelta(1, { after: 0 })).rejects.toThrow('author');
  });

  it('renders mention entities as display text in previews, not wire markup', async () => {
    const { service, read } = setup();
    read.mockImplementation(async () => [
      {
        seq: 3,
        createdAt: '2026-09-08T00:00:02Z',
        creatorAccount: 'peer',
        profileNamespaceId: 0,
        profileRev: 3,
        isDeleted: false,
        deletionType: null,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({
          text: '[@Reader](somfp://user/0/reader) hi [@All](somfp://audience/all)',
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
  const content = (text: string) => JSON.stringify({ text });
  it.each([
    [0, 0, true],
    [12, 12, true],
    [12, 15, false],
    [12, 0, false],
    [0, 12, false],
    [12, null, false],
    [0, null, false],
  ] as const)(
    'matches group-origin identities (token=%s, viewer=%s)',
    (target, viewer, expected) => {
      expect(
        mentionsAccount(content(`[@Reader](somfp://user/${target}/reader)`), {
          account: 'reader',
          namespaceId: viewer,
        }),
      ).toBe(expected);
    },
  );
  it('does not derive identity from labels, another account, escaped text, or case folding', () => {
    const self = { account: 'reader', namespaceId: 12 };
    for (const text of [
      '[@Reader](somfp://user/12/other)',
      String.raw`\[@Reader](somfp://user/12/reader)`,
      '[@Reader](somfp://user/12/Reader)',
      'plain text',
    ])
      expect(mentionsAccount(content(text), self)).toBe(false);
    expect(
      mentionsAccount(
        content('[@Unrelated label](somfp://user/12/reader)'),
        self,
      ),
    ).toBe(true);
    expect(
      mentionsAccount(content('[@All](somfp://audience/all)'), {
        account: 'reader',
        namespaceId: null,
      }),
    ).toBe(true);
  });
});
