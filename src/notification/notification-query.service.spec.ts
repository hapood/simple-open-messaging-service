import { describe, expect, it, vi } from 'vitest';
import { NotificationQueryService } from './notification-query.service.js';

function service() {
  return new NotificationQueryService(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { blockedByMe: vi.fn().mockResolvedValue(new Set()) } as never,
  );
}

describe('NotificationQueryService feed read model', () => {
  it('returns a clear descriptor when the feed discovered no changed threads', async () => {
    const result = await service().buildFeedNotifyResponse(7, [], {
      acceptLanguage: 'en',
    });
    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0]).toMatchObject({ kind: 'clear', count: 0 });
  });
});
