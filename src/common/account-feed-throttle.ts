interface PendingFeed {
  head: number;
  pending: number | undefined;
  timer?: NodeJS.Timeout;
}

/** Process-local best-effort hints: leading send, maximum trailing head, and
 * no overlapping sends for an account. Idle entries expire after one window. */
export class AccountFeedThrottle {
  private readonly accounts = new Map<number, PendingFeed>();
  private stopped = false;

  constructor(
    private readonly windowMs: number,
    private readonly send: (
      accountId: number,
      head: number,
    ) => void | Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  enqueue(accountId: number, head: number): void {
    if (this.stopped) return;
    const existing = this.accounts.get(accountId);
    if (existing) {
      if (head > existing.head) {
        existing.head = head;
        existing.pending = head;
      }
      return;
    }
    const entry: PendingFeed = { head, pending: head };
    this.accounts.set(accountId, entry);
    void this.flush(accountId, entry);
  }

  private async flush(accountId: number, entry: PendingFeed): Promise<void> {
    const head = entry.pending!;
    entry.pending = undefined;
    const nextAt = Date.now() + this.windowMs;
    try {
      await this.send(accountId, head);
    } catch (error) {
      this.onError(error);
    } finally {
      if (!this.stopped) {
        entry.timer = setTimeout(
          () => {
            if (entry.pending === undefined) this.accounts.delete(accountId);
            else void this.flush(accountId, entry);
          },
          Math.max(0, nextAt - Date.now()),
        );
        entry.timer.unref();
      }
    }
  }

  stop(): void {
    this.stopped = true;
    for (const entry of this.accounts.values()) clearTimeout(entry.timer);
    this.accounts.clear();
  }
}
