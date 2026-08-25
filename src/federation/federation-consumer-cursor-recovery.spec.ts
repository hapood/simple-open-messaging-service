import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import type { FederationMessageFeedPage } from './federation-message-feed.service.js';
import type { FederationMessageTombstonePage } from './federation-message-tombstone-feed.service.js';
import type { GroupMetaFeedPage } from './group-meta-feed.service.js';
import { FederationService, S2sResponseError } from './federation.service.js';

function cursorUnavailable(resumeAfter: string, resumeBefore: string) {
  return new S2sResponseError(
    'cursor unavailable',
    200,
    BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
    { resumeAfter, resumeBefore },
  );
}

function target() {
  const service = Object.create(
    FederationService.prototype,
  ) as FederationService & Record<string, unknown>;
  const warn = vi.fn();
  Object.assign(service, {
    logger: { warn },
    withTrustedPeer: vi.fn(
      (_domain: string, operation: () => Promise<unknown>) => operation(),
    ),
    threadKey: vi.fn(() => 'thread-key'),
    threadQuery: vi.fn(() => new URLSearchParams({ account: 'thread' })),
  });
  return { service, warn };
}

describe('FederationService consumer cursor recovery', () => {
  it('warns and rebuilds group metadata using the advertised recovery window', async () => {
    const { service, warn } = target();
    const fullPage: GroupMetaFeedPage = {
      account: '!group',
      mode: 'full',
      items: [],
      scannedThrough: '6',
      groupMetaFeedEndId: '6',
      hasMore: false,
    };
    const getSigned = vi
      .fn()
      .mockRejectedValueOnce(cursorUnavailable('0', '7'))
      .mockResolvedValueOnce(fullPage);
    Object.assign(service, { getSigned });
    const pull = service as unknown as {
      pullGroupMetaFeed(
        domain: string,
        account: string,
        mode: 'full' | 'delta',
        after: bigint,
      ): Promise<GroupMetaFeedPage>;
    };

    await expect(
      pull.pullGroupMetaFeed('peer.test', '!group', 'delta', 4n),
    ).resolves.toEqual(fullPage);
    expect(getSigned.mock.calls.map(([path]) => path)).toEqual([
      '/s2s/v1/group-meta?account=%21group&mode=delta&after=4&take=100',
      '/s2s/v1/group-meta?account=%21group&mode=full&after=0&take=100&through=6',
    ]);
    expect(warn).toHaveBeenCalledWith(
      'group-meta cursor for !group@peer.test is unavailable; rebuilding from 0 through 6',
    );
  });

  it('warns and resumes a message query from the peer recovery cursor', async () => {
    const { service, warn } = target();
    const getSigned = vi
      .fn()
      .mockRejectedValueOnce(cursorUnavailable('5', '11'))
      .mockResolvedValueOnce({ messages: [], scannedThrough: '10', hasMore: false });
    Object.assign(service, {
      getSigned,
      database: {
        db: { query: { federationMessageQueryCursor: {
          findFirst: vi.fn().mockResolvedValue({ committedThrough: 2 }),
        } } },
      },
    });
    const page = {
      items: [{
        feedId: '1',
        thread: { account: 'thread', domain: 'peer.test' },
        messageEndSeq: '10',
      }],
      scannedThrough: '1',
      messageFeedEndId: '1',
      hasMore: false,
    } as FederationMessageFeedPage;
    const pull = service as unknown as {
      pullMessageQueriesForFeedPage(
        domain: string,
        page: FederationMessageFeedPage,
      ): Promise<unknown[]>;
    };

    await expect(
      pull.pullMessageQueriesForFeedPage('peer.test', page),
    ).resolves.toEqual([]);
    expect(getSigned.mock.calls.map(([path]) => path)).toEqual([
      '/s2s/v1/messages?account=thread&after=2&through=10&take=100',
      '/s2s/v1/messages?account=thread&after=5&through=10&take=100',
    ]);
    expect(page.queryCursors).toEqual([
      { threadKey: 'thread-key', committedThrough: 10 },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'message query cursor for peer peer.test thread thread is unavailable; resuming from 5',
    );
  });

  it('warns and resumes a tombstone query from the peer recovery cursor', async () => {
    const { service, warn } = target();
    const getSigned = vi
      .fn()
      .mockRejectedValueOnce(cursorUnavailable('6', '13'))
      .mockResolvedValueOnce({
        tombstones: [],
        scannedThrough: '12',
        hasMore: false,
      });
    Object.assign(service, {
      getSigned,
      database: {
        db: { query: { federationTombstoneQueryCursor: {
          findFirst: vi.fn().mockResolvedValue({ committedThrough: 3n }),
        } } },
      },
    });
    const page = {
      items: [{
        feedId: '1',
        thread: { account: 'thread', domain: 'peer.test' },
        tombstoneEndSeq: '12',
      }],
      scannedThrough: '1',
      tombstoneFeedEndId: '1',
      hasMore: false,
    } as FederationMessageTombstonePage;
    const pull = service as unknown as {
      pullTombstoneQueriesForFeedPage(
        domain: string,
        page: FederationMessageTombstonePage,
      ): Promise<unknown[]>;
    };

    await expect(
      pull.pullTombstoneQueriesForFeedPage('peer.test', page),
    ).resolves.toEqual([]);
    expect(getSigned.mock.calls.map(([path]) => path)).toEqual([
      '/s2s/v1/message-tombstones?account=thread&after=3&through=12&take=100',
      '/s2s/v1/message-tombstones?account=thread&after=6&through=12&take=100',
    ]);
    expect(page.queryCursors).toEqual([
      { threadKey: 'thread-key', committedThrough: '12' },
    ]);
    expect(warn).toHaveBeenCalledWith(
      'tombstone query cursor for peer peer.test thread thread is unavailable; resuming from 6',
    );
  });
});
