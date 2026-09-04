import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationActionService } from './notification-action.service.js';

/**
 * handleAction — the notification button round-trip. Only `reply` reaches the backend:
 *  - `reply` → membership-gated writeMsgToThread + fanout.dispatch;
 *  - `dismiss` / `open` / unknown → no-op (dismiss is a pure frontend shade-close, never POSTed).
 * Never throws (a shade-button failure is best-effort).
 */
describe('NotificationActionService.handleAction', () => {
  let svc: NotificationActionService;
  let writeMsgToThread: ReturnType<typeof vi.fn>;
  let dispatch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeMsgToThread = vi.fn();
    dispatch = vi.fn();
    svc = new NotificationActionService(
      { writeMsgToThread } as never,
      { dispatch } as never,
    );
  });

  it('reply: membership-gated writeMsgToThread + dispatch', async () => {
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

  it('reply: ignores an authorization failure from the send transaction', async () => {
    writeMsgToThread.mockRejectedValue(new Error('not authorized'));
    await svc.handleAction(1, {
      tag: 'soms-msg-1',
      actionId: 'reply',
      threadId: 1,
      replyText: 'hi',
    });
    expect(writeMsgToThread).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dismiss / open / unknown actionId → no-op (no service calls)', async () => {
    // dismiss is a pure frontend shade-close — even if POSTed, the backend does nothing with it.
    await svc.handleAction(1, { tag: 'soms-thread-7', actionId: 'dismiss' });
    await svc.handleAction(1, { tag: 'soms-thread-7', actionId: 'open' });
    expect(writeMsgToThread).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never throws — a failure is swallowed (best-effort)', async () => {
    writeMsgToThread.mockRejectedValue(new Error('db down'));
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
