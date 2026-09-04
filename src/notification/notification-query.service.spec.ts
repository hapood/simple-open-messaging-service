import { describe, expect, it, vi } from 'vitest';
import { NotificationQueryService } from './notification-query.service.js';

function service(opts: { buckets?: Map<number, never> } = {}) {
  return new NotificationQueryService(
    {} as never,
    {
      awayAttentionByThread: vi
        .fn()
        .mockResolvedValue(opts.buckets ?? new Map()),
    } as never,
    {
      findUniqueUser: vi.fn().mockResolvedValue({ account: 'alice' }),
    } as never,
    {} as never,
  );
}

describe('NotificationQueryService feed read model', () => {
  it('returns no operation when the feed discovered no changed threads', async () => {
    const result = await service().buildFeedNotifyResponse(7, [], {
      acceptLanguage: 'en',
    });
    expect(result.notifications).toEqual([]);
  });

  it('returns no descriptor for a changed thread with no notification-worthy content', async () => {
    const result = await service().buildFeedNotifyResponse(7, [42], {
      acceptLanguage: 'en',
    });
    expect(result.notifications).toEqual([]);
  });
});
