export type SseReceipt = { sseUuid: string; threadFeedEndId: number };

/** One HTTP receipt per fixed three-second window, regardless of feed-event rate. */
export class SseReceiptCoalescer {
  private pending?: { receipt: SseReceipt; dueAt: number; retries: number };
  private timer?: ReturnType<typeof setTimeout>;
  private sending?: AbortController;
  private stopped = false;

  constructor(
    private readonly send: (
      receipt: SseReceipt,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {}

  queue(receipt: SseReceipt): void {
    if (this.stopped) return;
    if (this.pending) {
      if (
        this.pending.receipt.sseUuid !== receipt.sseUuid ||
        this.pending.receipt.threadFeedEndId <= receipt.threadFeedEndId
      )
        this.pending.receipt = receipt;
      this.pending.retries = 0;
    } else {
      this.pending = { receipt, dueAt: Date.now() + 3_000, retries: 0 };
    }
    this.schedule();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = undefined;
    this.sending?.abort();
  }

  private schedule(): void {
    if (this.stopped || !this.pending || this.timer) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.flush();
      },
      Math.max(0, this.pending.dueAt - Date.now()),
    );
  }

  private async flush(): Promise<void> {
    if (this.stopped || this.sending || !this.pending) return;
    const entry = this.pending;
    this.pending = undefined;
    const aborter = new AbortController();
    this.sending = aborter;
    try {
      await this.send(entry.receipt, aborter.signal);
    } catch {
      // A late receipt is harmless, but never build an unbounded retry queue.
      if (!this.stopped && !this.pending && entry.retries === 0) {
        this.pending = { ...entry, dueAt: Date.now() + 1_000, retries: 1 };
      }
    } finally {
      this.sending = undefined;
      this.schedule();
    }
  }
}
