import { describe, expect, it, vi } from 'vitest';
import { ContentType } from '../database/enums.js';
import { MessageFanoutService } from './message-fanout.service.js';

describe('MessageFanoutService federation boundary', () => {
  it('never wakes federation for a local SYSTEM message', async () => {
    const federation = { notifyOnSend: vi.fn() };
    const service = new MessageFanoutService(
      { onNewMessage: vi.fn() } as never,
      { dispatchForMessage: vi.fn() } as never,
      federation as never,
      { getActiveParticipantUserIds: vi.fn().mockResolvedValue([]) } as never,
    );

    await service.dispatch({
      threadId: 7,
      creator: 2,
      seq: 4,
      contentType: ContentType.SYSTEM,
      content: JSON.stringify({ type: 'FRIEND_ADDED' }),
      isDeleted: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    expect(federation.notifyOnSend).not.toHaveBeenCalled();
  });
});
