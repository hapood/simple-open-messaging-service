import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationActionService } from './notification-action.service.js';
import { ThreadParticipantState } from '../database/enums.js';

/**
 * handleAction — the notification button round-trip. Only `reply` reaches the backend:
 *  - `reply` → membership-gated writeMsgToThread + fanout.dispatch;
 *  - `dismiss` / `open` / unknown → no-op (dismiss is a pure frontend shade-close, never POSTed).
 * Never throws (a shade-button failure is best-effort).
 */
describe('NotificationActionService.handleAction', () => {
  let svc: NotificationActionService;
  let findParticipant: ReturnType<typeof vi.fn>;
  let writeMsgToThread: ReturnType<typeof vi.fn>;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findParticipant = vi.fn();
    writeMsgToThread = vi.fn();
    dispatch = vi.fn();
    svc = new NotificationActionService(
      { findParticipant } as never,
      { writeMsgToThread } as never,
      { dispatch } as never,
    );
  });

  it('reply: membership-gated writeMsgToThread + dispatch', async () => {
    findParticipant.mockResolvedValue({
      state: ThreadParticipantState.ESTABLISHED,
    });
    const sent = { threadId: 1, seq: 9, content: 'hi' };
    writeMsgToThread.mockResolvedValue(sent);

    await svc.handleAction(1, {
      tag: 'soms-msg-1',
      actionId: 'reply',
      threadId: 1,
      replyText: '  hi  ',
    });

    expect(writeMsgToThread).toHaveBeenCalledWith(
      1,
      1,
      JSON.stringify({ text: 'hi' }),
      'PURE_TEXT',
    ); // trimmed + canonical text envelope
    expect(dispatch).toHaveBeenCalledWith(sent);
  });

  it('reply: refuses a non-member (no write)', async () => {
    findParticipant.mockResolvedValue(null);
    await svc.handleAction(1, {
      tag: 'soms-msg-1',
      actionId: 'reply',
      threadId: 1,
      replyText: 'hi',
    });
    expect(writeMsgToThread).not.toHaveBeenCalled();
  });

  it('dismiss / open / unknown actionId → no-op (no service calls)', async () => {
    // dismiss is a pure frontend shade-close — even if POSTed, the backend does nothing with it.
    await svc.handleAction(1, { tag: 'soms-away', actionId: 'dismiss' });
    await svc.handleAction(1, { tag: 'soms-away', actionId: 'open' });
    expect(writeMsgToThread).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never throws — a failure is swallowed (best-effort)', async () => {
    findParticipant.mockRejectedValue(new Error('db down'));
    await expect(
      svc.handleAction(1, {
        tag: 'soms-msg-1',
        actionId: 'reply',
        threadId: 1,
        replyText: 'hi',
      }),
    ).resolves.toBeUndefined();
  });
});
