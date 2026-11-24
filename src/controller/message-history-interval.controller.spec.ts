import { describe, expect, it, vi } from 'vitest';
import type { MessageEvent } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { of } from 'rxjs';
import { BusinessCode } from '../common/business-code.js';
import { MessageHistoryIntervalController } from './message-history-interval.controller.js';

function setup(participant: unknown = {}) {
  const findActiveParticipantWithThread = vi
    .fn()
    .mockResolvedValue(participant);
  const open = vi.fn().mockReturnValue(
    of({
      threadId: 2,
      left: 90,
      right: 110,
    }),
  );
  const controller = new MessageHistoryIntervalController(
    { findActiveParticipantWithThread } as never,
    { open } as never,
  );
  return {
    controller,
    findActiveParticipantWithThread,
    open,
    req: { user: { userId: 1 } } as FastifyRequest,
  };
}

describe('MessageHistoryIntervalController', () => {
  it('authorizes the thread and emits MESSAGE_HISTORY_INTERVAL without a message payload', async () => {
    const s = setup();
    const stream = await s.controller.historyInterval(s.req, {
      threadId: 2,
      left: 90,
      right: 110,
    });
    const events: MessageEvent[] = [];
    const subscription = stream.subscribe((event) => events.push(event));

    expect(s.findActiveParticipantWithThread).toHaveBeenCalledWith(1, 2);
    expect(s.open).toHaveBeenCalledWith(1, 2, 90, 110);
    expect(
      events.filter((event) => event.type === 'MESSAGE_HISTORY_INTERVAL'),
    ).toEqual([
      {
        type: 'MESSAGE_HISTORY_INTERVAL',
        data: { threadId: 2, left: 90, right: 110 },
      },
    ]);
    subscription.unsubscribe();
  });

  it('hides a thread the caller cannot read', async () => {
    const s = setup(null);
    await expect(
      s.controller.historyInterval(s.req, {
        threadId: 2,
        left: 90,
        right: 110,
      }),
    ).rejects.toMatchObject({ bizCode: BusinessCode.THREAD_NOT_FOUND });
    expect(s.open).not.toHaveBeenCalled();
  });

  it.each([
    { threadId: 2, left: 90, right: 90 },
    { threadId: 2, left: 91, right: 90 },
    { threadId: 2, left: -1, right: 90 },
    { threadId: 2, left: 1.5, right: 90 },
    { threadId: 0, left: 0, right: 90 },
    { threadId: Number.MAX_SAFE_INTEGER + 1, left: 0, right: 90 },
    { threadId: 2, left: 0, right: Infinity },
  ])('rejects invalid coordinates before opening demand: %j', async (dto) => {
    const s = setup();
    await expect(
      s.controller.historyInterval(s.req, dto),
    ).rejects.toMatchObject({ bizCode: BusinessCode.VALIDATION_FAILED });
    expect(s.findActiveParticipantWithThread).not.toHaveBeenCalled();
    expect(s.open).not.toHaveBeenCalled();
  });
});
