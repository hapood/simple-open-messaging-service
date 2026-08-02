import type { CbDemand } from './cb-source';
import { CbDemandCancelled, type CbDemandResult } from './cb-source';
import type { Subscription } from 'rxjs';

export interface ActiveCbDemand<T> {
  readonly promise: Promise<CbDemandResult<T>>;
  readonly subscription: Subscription;
  cancel(): void;
}

/** Atomic lifecycle state for one cancellable, single-flight source edge. */
export class EdgeDemandState<T> {
  active: ActiveCbDemand<T> | null = null;
  error: unknown | null = null;
  retrying = false;

  begin(demand: CbDemand<T>): ActiveCbDemand<T> {
    let settled = false;
    let rejectPromise!: (reason: unknown) => void;
    let subscription!: Subscription;
    const promise = new Promise<CbDemandResult<T>>((resolve, reject) => {
      rejectPromise = reject;
      subscription = demand.subscribe({
        next: (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
          subscription?.unsubscribe();
        },
        error: (error) => {
          if (settled) return;
          settled = true;
          reject(error);
        },
        complete: () => {
          if (settled) return;
          settled = true;
          reject(new Error('chat-box demand completed without a result'));
        },
      });
      if (settled) subscription.unsubscribe();
    });
    const handle: ActiveCbDemand<T> = {
      promise,
      get subscription() {
        return subscription;
      },
      cancel: () => {
        if (settled) return;
        settled = true;
        handle.subscription.unsubscribe();
        rejectPromise(new CbDemandCancelled());
      },
    };
    this.active = handle;
    return handle;
  }

  cancel(): void {
    const handle = this.active;
    this.active = null;
    this.retrying = false;
    handle?.cancel();
  }

  isCurrent(handle: ActiveCbDemand<T>): boolean {
    return this.active === handle;
  }

  finish(handle: ActiveCbDemand<T>): void {
    if (!this.isCurrent(handle)) return;
    this.active = null;
    this.retrying = false;
  }
}
