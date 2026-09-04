import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationGroupMetaClient } from './federation-group-meta-client.service.js';
import type { GroupMetaFeedPage } from './group-meta-feed.service.js';

function harness(result: GroupMetaFeedPage | Error) {
  const get =
    result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
  const runWithRetry = vi.fn(
    async (_peer: string, _name: string, operation: () => Promise<unknown>) =>
      operation(),
  );
  return {
    client: new FederationGroupMetaClient(
      { get } as never,
      { runWithRetry } as never,
    ),
    get,
    runWithRetry,
  };
}

const request = {
  account: '!group',
  mode: 'delta' as const,
  after: 3n,
  through: 8n,
};

describe('FederationGroupMetaClient', () => {
  it('fetches exactly one fixed-through page through the network scheduler', async () => {
    const page: GroupMetaFeedPage = {
      account: '!group',
      mode: 'delta',
      items: [
        {
          feedId: '5',
          account: 'alice',
          domain: 'peer.test',
          operation: 'UPSERT',
          body: { role: 'MEMBER', profileRev: 1 },
        },
      ],
      scannedThrough: '5',
      groupMetaFeedEndId: '10',
      hasMore: true,
    };
    const { client, get, runWithRetry } = harness(page);

    await expect(client.fetchPage('peer.test', request)).resolves.toBe(page);

    expect(runWithRetry).toHaveBeenCalledOnce();
    expect(get).toHaveBeenCalledWith(
      '/s2s/v1/group-meta?account=%21group&mode=delta&after=3&take=100&through=8',
      'peer.test',
      16 * 1024 * 1024,
    );
  });

  it('maps a valid unavailable cursor window for the durable task', async () => {
    const { client } = harness(
      new S2sResponseError(
        'cursor unavailable',
        200,
        BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        { resumeAfter: '2', resumeBefore: '11' },
      ),
    );

    const error = await client
      .fetchPage('peer.test', request)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteFeedCursorUnavailableError);
    expect(error).toMatchObject({ resumeAfter: 2n, resumeBefore: 11n });
  });

  it('rejects invalid page boundaries and unordered items', async () => {
    const { client } = harness({
      account: '!group',
      mode: 'delta',
      items: [
        {
          feedId: '5',
          account: 'alice',
          domain: 'peer.test',
          operation: 'DEPART',
        },
        {
          feedId: '4',
          operation: 'GROUP_PROFILE',
          body: { profileRev: 1 },
        },
      ],
      scannedThrough: '5',
      groupMetaFeedEndId: '8',
      hasMore: true,
    });

    await expect(client.fetchPage('peer.test', request)).rejects.toThrow(
      'unordered group-meta page items',
    );
  });

  it('does not retry or remap malformed recovery data', async () => {
    const { client } = harness(
      new S2sResponseError(
        'cursor unavailable',
        200,
        BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        { resumeAfter: '5', resumeBefore: '5' },
      ),
    );

    await expect(client.fetchPage('peer.test', request)).rejects.toThrow(
      'invalid group-meta recovery window',
    );
  });
});
