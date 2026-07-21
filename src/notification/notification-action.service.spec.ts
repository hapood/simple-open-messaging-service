import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotificationActionService } from './notification-action.service.js';

/**
 * handleAction — the notification button round-trip. Pins:
 *  - `mark-all-read` → advanceReadCursor per covered thread + an onReadCursor frame when it moved; skips
 *    empty threads + threads the caller isn't an active member of;
 *  - `reply` → membership-gated + quota-gated writeMsgToThread + fanout.dispatch;
 *  - `open` / unknown → no-op.
 * Never throws (a shade-button failure is best-effort).
 */
describe('NotificationActionService.handleAction', () => {
  let svc: NotificationActionService;
  let findParticipant: ReturnType<typeof vi.fn>;
  let advanceReadCursor: ReturnType<typeof vi.fn>;
  let findThread: ReturnType<typeof vi.fn>;
  let writeMsgToThread: ReturnType<typeof vi.fn>;
  let dispatch: ReturnType<typeof vi.fn>;
  let onReadCursor: ReturnType<typeof vi.fn>;
  let tryTickLocal: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    findParticipant = vi.fn();
    advanceReadCursor = vi.fn();
    findThread = vi.fn();
    writeMsgToThread = vi.fn();
    dispatch = vi.fn();
    onReadCursor = vi.fn();
    tryTickLocal = vi.fn();
    svc = new NotificationActionService(
      { findParticipant, advanceReadCursor } as never,
      { findThread, writeMsgToThread } as never,
      { dispatch } as never,
      { onReadCursor } as never,
      { tryTickLocal } as never,
    );
  });

  it('mark-all-read: advances the cursor + emits onReadCursor per active, non-empty thread', async () => {
    findThread.mockImplementation((tid: number) =>
      Promise.resolve(tid === 2 ? { lastMessageSeq: null } : { lastMessageSeq: 5 }),
    );
    findParticipant.mockResolvedValue({ leftAt: null });
    advanceReadCursor.mockResolvedValue(true);

    await svc.handleAction(1, { tag: 'soms-away', actionId: 'mark-all-read', threadIds: [1, 2] });

    // thread 2 is empty → skipped; only thread 1 advanced + framed.
    expect(advanceReadCursor).toHaveBeenCalledTimes(1);
    expect(advanceReadCursor).toHaveBeenCalledWith(1, 1, 5);
    expect(onReadCursor).toHaveBeenCalledTimes(1);
  });

  it('mark-all-read: skips threads the caller is not an active member of', async () => {
    findThread.mockResolvedValue({ lastMessageSeq: 5 });
    findParticipant.mockImplementation((uid: number, tid: number) =>
      Promise.resolve(tid === 1 ? { leftAt: null } : null),
    );
    advanceReadCursor.mockResolvedValue(true);

    await svc.handleAction(1, { tag: 'soms-away', actionId: 'mark-all-read', threadIds: [1, 2] });

    expect(advanceReadCursor).toHaveBeenCalledTimes(1); // only thread 1
    expect(advanceReadCursor).toHaveBeenCalledWith(1, 1, 5);
  });

  it('mark-all-read: suppresses the onReadCursor frame when the cursor did not move (idempotent)', async () => {
    findThread.mockResolvedValue({ lastMessageSeq: 5 });
    findParticipant.mockResolvedValue({ leftAt: null });
    advanceReadCursor.mockResolvedValue(false); // already read

    await svc.handleAction(1, { tag: 'soms-away', actionId: 'mark-all-read', threadIds: [1] });

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
    findThread.mockRejectedValue(new Error('db down'));
    await expect(
      svc.handleAction(1, { tag: 'soms-away', actionId: 'mark-all-read', threadIds: [1] }),
    ).resolves.toBeUndefined();
  });
});
