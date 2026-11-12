import { Injectable, OnDestroy, signal } from '@angular/core';

/** Gates routed UI while browser session admission is still being restored. */
@Injectable({ providedIn: 'root' })
export class SessionStartupService implements OnDestroy {
  readonly restoring = signal(false);
  readonly failed = signal(false);
  readonly retryIn = signal<number | null>(null);
  private retryAction?: () => void;
  private releaseRetry?: () => void;
  private destroyed = false;

  ngOnDestroy(): void {
    this.destroyed = true;
    this.releaseRetry?.();
  }

  retryNow(): void {
    this.retryAction?.();
  }

  /** Attach only a backoff wake-up; never interrupt an in-flight handshake. */
  offerRetry(delay: number, retry: () => void): () => void {
    if (this.destroyed) return () => {};
    this.releaseRetry?.();
    const deadline = Date.now() + delay;
    this.retryAction = retry;
    this.retryIn.set(delay);
    const timer = setInterval(() => this.retryIn.set(Math.max(0, deadline - Date.now())), 250);
    const release = () => {
      clearInterval(timer);
      if (this.retryAction === retry) {
        this.retryAction = undefined;
        this.retryIn.set(null);
      }
    };
    this.releaseRetry = release;
    return release;
  }

  async run(restore: () => Promise<void>): Promise<void> {
    if (this.destroyed) return;
    this.restoring.set(true);
    this.failed.set(false);
    try {
      await restore();
    } catch (error) {
      this.failed.set(true);
      console.error('[session] startup failed', error);
      // Fail closed: do not mount routed business UI after unexpected startup failure.
      return;
    }
    if (!this.destroyed) this.restoring.set(false);
  }
}
