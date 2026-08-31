import { describe, expect, it, vi } from 'vitest';
import { BusinessCode } from '../common/business-code.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationStatePullService } from './federation-state-pull.service.js';
import type { GroupMetaFeedPage } from './group-meta-feed.service.js';

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
    FederationStatePullService.prototype,
  ) as FederationStatePullService & Record<string, unknown>;
  const warn = vi.fn();
  Object.assign(service, {
    logger: { warn },
    trustedPeers: {
      run: vi.fn((_domain: string, operation: () => Promise<unknown>) =>
        operation(),
      ),
    },
  });
  return { service, warn };
}

describe('FederationStatePullService consumer cursor recovery', () => {
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
    const get = vi
      .fn()
      .mockRejectedValueOnce(cursorUnavailable('0', '7'))
      .mockResolvedValueOnce(fullPage);
    Object.assign(service, { peerHttp: { get } });
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
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      '/s2s/v1/group-meta?account=%21group&mode=delta&after=4&take=100',
      '/s2s/v1/group-meta?account=%21group&mode=full&after=0&take=100&through=6',
    ]);
    expect(warn).toHaveBeenCalledWith(
      'group-meta cursor for !group@peer.test is unavailable; rebuilding from 0 through 6',
    );
  });
});
