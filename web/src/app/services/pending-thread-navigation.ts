/** Native owns the pending tap; acknowledge only after the existing navigator accepts it. */
export function consumePendingThreadNavigation(
  bridge:
    | {
        getPendingThreadId(): string | null;
        acknowledgeThreadId(threadId: string): void;
      }
    | undefined,
  open: (threadId: number) => void,
): void {
  const pending = bridge?.getPendingThreadId();
  if (!pending) return;
  const threadId = Number(pending);
  if (!Number.isInteger(threadId) || threadId <= 0 || threadId > 2_147_483_647)
    return;
  open(threadId);
  bridge!.acknowledgeThreadId(pending);
}
