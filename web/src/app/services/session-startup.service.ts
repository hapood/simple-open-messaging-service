import { Injectable, OnDestroy, signal } from '@angular/core';
import type { DatabaseInitFailureKind } from './session/database-init-failure';

/** Gates routed UI while browser session admission is still being restored. */
@Injectable({ providedIn: 'root' })
export class SessionStartupService implements OnDestroy {
  readonly restoring = signal(false);
  readonly failed = signal(false);
  readonly retryIn = signal<number | null>(null);
  readonly databaseFailure = signal<DatabaseInitFailureKind | null>(null);
  private databaseChoice?: (choice: 'rebuild' | 'exit') => void;
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

  /** Pause restoration until the logo screen's Material dialog returns a choice. */
  decideDatabase(kind: DatabaseInitFailureKind): Promise<'rebuild' | 'exit'> {
    this.databaseFailure.set(kind);
    return new Promise((resolve) => {
      this.databaseChoice = resolve;
    });
  }

  answerDatabase(choice: 'rebuild' | 'exit'): void {
    const answer = this.databaseChoice;
    this.databaseChoice = undefined;
    this.databaseFailure.set(null);
    answer?.(choice);
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
