import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { RemoteGroupMetaCursorUnavailableError } from './federation-feed-cursor-error.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationGroupMetaClient } from './federation-group-meta-client.service.js';
import type { GroupMetaFeedPage } from './group-meta-feed.service.js';

function harness(result: GroupMetaFeedPage | Error) {
  const get =
    result instanceof Error
      ? vi.fn().mockRejectedValue(result)
      : vi.fn().mockResolvedValue(result);
  const signal = new AbortController().signal;
  return {
    client: new FederationGroupMetaClient(
      { get } as never,
      {
        captureActiveById: vi.fn().mockResolvedValue({
          domain: 'peer.test',
          namespaceId: 9,
          peerAssignedLocalNamespaceId: 1,
          rootPublicKey: 'root',
        }),
      } as never,
    ),
    get,
    signal,
  };
}

const request = {
  account: '!group',
  mode: 'delta' as const,
  after: 3,
  through: 8,
};

describe('FederationGroupMetaClient', () => {
  it('fetches one page by namespace without a local retry loop', async () => {
    const page: GroupMetaFeedPage = {
      account: '!group',
      mode: 'delta',
      items: [
        {
          feedId: 5,
          originCreatedAt: 0,
          operation: 'MEMBER_UPSERT',
          body: {
            account: 'alice',
            namespaceId: 7,
            role: 'MEMBER',
            profileRev: 1,
          },
        },
      ],
      scannedThrough: 5,
      groupMetaFeedEndId: 10,
      hasMore: true,
    };
    const { client, get, signal } = harness(page);

    await expect(client.fetchPage(9, request, signal)).resolves.toBe(page);

    expect(get).toHaveBeenCalledWith(
      '/somfp/v1/group-meta?account=%21group&mode=delta&after=3&take=100&through=8',
      'peer.test',
      16 * 1024 * 1024,
      signal,
    );
  });

  it('does not request after the caller has cancelled', async () => {
    const { client, get } = harness({
      account: '!group',
      mode: 'delta',
      items: [],
      scannedThrough: 3,
      groupMetaFeedEndId: 8,
      hasMore: false,
    });
    const signal = AbortSignal.abort();
    await expect(client.fetchPage(9, request, signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('maps a valid unavailable cursor window for the durable task', async () => {
    const { client } = harness(
      new S2sResponseError(
        'cursor unavailable',
        200,
        BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        { resumeAfter: 2, resumeBefore: 11 },
      ),
    );

    const error = await client
      .fetchPage(9, request, new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RemoteGroupMetaCursorUnavailableError);
    expect(error).toMatchObject({ resumeAfter: 2, resumeBefore: 11 });
  });

  it('rejects invalid page boundaries and unordered items', async () => {
    const { client } = harness({
      account: '!group',
      mode: 'delta',
      items: [
        {
          feedId: 5,
          originCreatedAt: 0,
          operation: 'MEMBER_DEPART',
          body: {
            account: 'alice',
            namespaceId: 7,
            role: 'MEMBER',
            profileRev: 3,
          },
        },
        {
          feedId: 4,
          originCreatedAt: 0,
          operation: 'GROUP_PROFILE',
          body: { account: '!group', namespaceId: 0, profileRev: 1 },
        },
      ],
      scannedThrough: 5,
      groupMetaFeedEndId: 8,
      hasMore: true,
    });

    await expect(
      client.fetchPage(9, request, new AbortController().signal),
    ).rejects.toThrow('unordered group-meta page items');
  });

  it('does not retry or remap malformed recovery data', async () => {
    const { client } = harness(
      new S2sResponseError(
        'cursor unavailable',
        200,
        BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE,
        { resumeAfter: 5, resumeBefore: 5 },
      ),
    );

    await expect(
      client.fetchPage(9, request, new AbortController().signal),
    ).rejects.toThrow('invalid group-meta recovery window');
  });
});
