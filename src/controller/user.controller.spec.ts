import { describe, expect, it, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { UserController } from './user.controller.js';

function setup() {
  const clientStateFeed = {
    readEndId: vi.fn().mockResolvedValue(6),
    query: vi.fn().mockResolvedValue([]),
    rejectMissingAfter: vi.fn(),
  };
  const controller = new UserController(
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    clientStateFeed as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const req = { user: { userId: 7 } } as unknown as FastifyRequest;
  return { controller, clientStateFeed, req };
}

describe('UserController.queryStateFeed', () => {
  it('returns a fixed full-mode feed window', async () => {
    const { controller, clientStateFeed, req } = setup();
    clientStateFeed.query.mockResolvedValue([
      {
        feedId: 5,
        account: 'alice',
        domain: '',
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: '',
        body: { displayName: 'Alice', avatar: null, bio: '', profileRev: 2 },
      },
    ]);

    await expect(
      controller.queryStateFeed(req, 'full', '0', '100', '6'),
    ).resolves.toEqual({
      mode: 'full',
      items: [expect.objectContaining({ feedId: 5, eventType: 'PROFILE' })],
      scannedThrough: 6,
      stateFeedEndId: 6,
      hasMore: false,
    });
    expect(clientStateFeed.query).toHaveBeenCalledWith(7, 'full', 0, 6);
  });

  it('delegates a missing cursor to the feed reset response', async () => {
    const { controller, clientStateFeed, req } = setup();
    const reset = { resumeAfter: 0, resumeBefore: 7 };
    clientStateFeed.rejectMissingAfter.mockReturnValue(reset);

    await expect(controller.queryStateFeed(req, 'delta')).resolves.toBe(reset);
    expect(clientStateFeed.query).not.toHaveBeenCalled();
  });
});
