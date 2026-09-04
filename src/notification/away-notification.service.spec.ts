import { describe, expect, it, vi } from 'vitest';
import { AwayNotificationService } from './away-notification.service.js';

function service(rows: Array<{ body: unknown }>) {
  const orderBy = vi.fn().mockResolvedValue(rows);
  const query = {
    from: vi.fn(),
    where: vi.fn(),
    orderBy,
  };
  query.from.mockReturnValue(query);
  query.where.mockReturnValue(query);
  const buildFeedNotifyResponse = vi
    .fn()
    .mockResolvedValue({ notifications: [] });
  const svc = new AwayNotificationService(
    {
      db: {
        query: {
          account: {
            findFirst: vi
              .fn()
              .mockResolvedValue({ stateFeedAllocatedThrough: 8 }),
          },
        },
        select: vi.fn().mockReturnValue(query),
      },
    } as never,
    { buildFeedNotifyResponse } as never,
  );
  return { svc, buildFeedNotifyResponse };
}

describe('AwayNotificationService delta semantics', () => {
  it('returns a no-op when the requested cursor has no newer thread head', async () => {
    const { svc, buildFeedNotifyResponse } = service([]);

    await expect(svc.query(7, { after: 8 })).resolves.toEqual({
      notifications: [],
      stateFeedEndId: 8,
    });
    expect(buildFeedNotifyResponse).not.toHaveBeenCalled();
  });

  it('passes only feed-discovered thread ids to the notification read model', async () => {
    const { svc, buildFeedNotifyResponse } = service([
      { body: { threadId: 42 } },
      { body: { threadId: 'invalid' } },
    ]);

    await svc.query(7, { after: 5, previewMode: 'private' });

    expect(buildFeedNotifyResponse).toHaveBeenCalledWith(
      7,
      [42],
      expect.objectContaining({ after: 5, previewMode: 'private' }),
    );
  });
});
