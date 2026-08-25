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
        domain: 'local',
        eventType: 'PROFILE',
        subjectAccount: '',
        subjectDomain: 'local',
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

  it('returns the recovery error when the cursor is missing', async () => {
    const { controller, clientStateFeed, req } = setup();
    const error = new Error('cursor unavailable');
    clientStateFeed.rejectMissingAfter.mockRejectedValue(error);

    await expect(controller.queryStateFeed(req, 'delta')).rejects.toBe(error);
    expect(clientStateFeed.rejectMissingAfter).toHaveBeenCalledWith(7);
    expect(clientStateFeed.query).not.toHaveBeenCalled();
  });

  it('returns code 30006 data when the cursor is ahead of the feed', async () => {
    const { controller, clientStateFeed, req } = setup();

    await expect(
      controller.queryStateFeed(req, 'delta', '9', '100', '9'),
    ).rejects.toMatchObject({
      bizCode: 30006,
      data: { resumeAfter: 0, resumeBefore: 7 },
    });
    expect(clientStateFeed.query).not.toHaveBeenCalled();
  });
});
