import { describe, expect, it, vi } from 'vitest';
import { ClientStateFeedService } from './client-state-feed.service.js';

describe('ClientStateFeedService', () => {
  it('normalizes Date values before persisting a client feed body', async () => {
    const values = vi.fn().mockReturnValue({
      onConflictDoUpdate: vi.fn().mockResolvedValue(undefined),
    });
    const tx = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      }),
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            returning: vi.fn().mockResolvedValue([{ feedId: 7 }]),
          }),
        }),
      }),
      insert: vi.fn().mockReturnValue({ values }),
    };
    const service = new ClientStateFeedService(
      undefined as never,
      undefined as never,
      undefined as never,
    );
    const requestedAt = new Date('2026-08-25T07:22:30.552Z');

    await service.writeInTx(tx as never, {
      userId: 1,
      account: 'admin',
      domain: 'local',
      eventType: 'RELATIONSHIP_INTENT',
      subjectAccount: '!group',
      subjectDomain: 'alpha.test',
      body: { status: 'REQUESTED', requestedAt },
    });

    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        feedId: 7,
        body: {
          status: 'REQUESTED',
          requestedAt: requestedAt.getTime(),
        },
      }),
    );
  });
});
