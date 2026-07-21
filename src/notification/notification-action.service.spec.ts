import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationActionService } from './notification-action.service.js';

/**
 * handleAction — the notification button round-trip. Pins:
 *  - `mark-all-read` → resolve the HWM cursor (threadId, seq) to a global id (the ceiling), then
 *    advanceReadCursor on each active thread up to that ceiling + an onReadCursor frame per thread that
 *    moved; an unresolvable cursor is a no-op;
 *  - `reply` → membership-gated + quota-gated writeMsgToThread + fanout.dispatch;
 *  - `open` / unknown → no-op.
 * Never throws (a shade-button failure is best-effort).
 */
describe('NotificationActionService.handleAction', () => {
  let svc: NotificationActionService;
  let findParticipant: ReturnType<typeof vi.fn>;
  let advanceReadCursor: ReturnType<typeof vi.fn>;
  let findMsgs: ReturnType<typeof vi.fn>;
  let maxReadSeq: ReturnType<typeof vi.fn>;
  let writeMsgToThread: ReturnType<typeof vi.fn>;
  let dispatch: ReturnType<typeof vi.fn>;
  let onReadCursor: ReturnType<typeof vi.fn>;
  let tryTickLocal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findParticipant = vi.fn();
    advanceReadCursor = vi.fn();
    findMsgs = vi.fn();
    maxReadSeq = vi.fn();
    writeMsgToThread = vi.fn();
    dispatch = vi.fn();
    onReadCursor = vi.fn();
    tryTickLocal = vi.fn();
    svc = new NotificationActionService(
      { findParticipant, advanceReadCursor } as never,
      { findMessagesBySeqPairs: findMsgs, maxReadSeqByThreadUpTo: maxReadSeq, writeMsgToThread } as never,
      { dispatch } as never,
      { onReadCursor } as never,
      { tryTickLocal } as never,
    );
  });

  it('mark-all-read: resolves the cursor → advances each active thread up to the ceiling + frames each that moved', async () => {
    findMsgs.mockResolvedValue([{ id: 500n }]); // cursor (7, 3) → global id 500 (the ceiling)
    maxReadSeq.mockResolvedValue(new Map([[1, 5], [2, 9]]));
    advanceReadCursor.mockResolvedValue(true);

    await svc.handleAction(1, { tag: 'soms-away', actionId: 'mark-all-read', threadId: 7, seq: 3 });

    expect(findMsgs).toHaveBeenCalledWith([{ threadId: 7, seq: 3 }]);
    expect(maxReadSeq).toHaveBeenCalledWith(1, 500n);
    expect(advanceReadCursor).toHaveBeenCalledTimes(2);
    expect(advanceReadCursor).toHaveBeenCalledWith(1, 1, 5);
    expect(advanceReadCursor).toHaveBeenCalledWith(1, 2, 9);
    expect(onReadCursor).toHaveBeenCalledTimes(2);
  });

  it('mark-all-read: an unresolvable cursor (stale/foreign) is a no-op', async () => {
    findMsgs.mockResolvedValue([]); // (threadId, seq) matches no message

    await svc.handleAction(1, { tag: 'soms-away', actionId: 'mark-all-read', threadId: 7, seq: 3 });

    expect(maxReadSeq).not.toHaveBeenCalled();
    expect(advanceReadCursor).not.toHaveBeenCalled();
    expect(onReadCursor).not.toHaveBeenCalled();
  });

  it('mark-all-read: suppresses onReadCursor when the cursor did not move (idempotent)', async () => {
    findMsgs.mockResolvedValue([{ id: 500n }]);
    maxReadSeq.mockResolvedValue(new Map([[1, 5]]));
    advanceReadCursor.mockResolvedValue(false); // already read

    await svc.handleAction(1, { tag: 'soms-away', actionId: 'mark-all-read', threadId: 7, seq: 3 });

    expect(advanceReadCursor).toHaveBeenCalled();
    expect(onReadCursor).not.toHaveBeenCalled();
  });

  it('reply: membership + quota gated writeMsgToThread + dispatch', async () => {
    findParticipant.mockResolvedValue({ leftAt: null });
    tryTickLocal.mockResolvedValue({ exceeded: false });
    const sent = { threadId: 1, seq: 9, content: 'hi' };
    writeMsgToThread.mockResolvedValue(sent);

    await svc.handleAction(1, { tag: 'soms-msg-1', actionId: 'reply', threadId: 1, replyText: '  hi  ' });

    expect(writeMsgToThread).toHaveBeenCalledWith(1, 1, 'hi', 'PURE_TEXT'); // trimmed
    expect(dispatch).toHaveBeenCalledWith(sent);
  });

  it('reply: refuses a non-member (no write)', async () => {
    findParticipant.mockResolvedValue(null);
    await svc.handleAction(1, { tag: 'soms-msg-1', actionId: 'reply', threadId: 1, replyText: 'hi' });
    expect(writeMsgToThread).not.toHaveBeenCalled();
  });

  it('reply: over-quota is a silent no-op (the user retries in-app)', async () => {
    findParticipant.mockResolvedValue({ leftAt: null });
    tryTickLocal.mockResolvedValue({ exceeded: true });
    await svc.handleAction(1, { tag: 'soms-msg-1', actionId: 'reply', threadId: 1, replyText: 'hi' });
    expect(writeMsgToThread).not.toHaveBeenCalled();
  });

  it('open / unknown actionId → no-op (no service calls)', async () => {
    await svc.handleAction(1, { tag: 'soms-away', actionId: 'open' });
    expect(advanceReadCursor).not.toHaveBeenCalled();
    expect(writeMsgToThread).not.toHaveBeenCalled();
  });

  it('never throws — a failure is swallowed (best-effort)', async () => {
    findMsgs.mockRejectedValue(new Error('db down'));
    await expect(
      svc.handleAction(1, { tag: 'soms-away', actionId: 'mark-all-read', threadId: 7, seq: 3 }),
    ).resolves.toBeUndefined();
  });
});
