import type { CbDemand } from './cb-source';
import type { CbDemandResult } from './cb-source';
import {
  observeOn,
  queueScheduler,
  Subscriber,
  take,
  type Subscription,
} from 'rxjs';

/** One source edge owns its subscription and delivers mutations synchronously. */
export class EdgeDemandState<T> {
  active: Subscription | null = null;
  error: unknown | null = null;
  retrying = false;

  subscribe(
    demand: CbDemand<T>,
    deliver: (result: CbDemandResult<T>) => void,
  ): void {
    if (this.active) return;
    let delivered = false;
    const release = () => {
      subscriber.unsubscribe();
      this.active = null;
      this.retrying = false;
    };
    const subscriber = new Subscriber<CbDemandResult<T>>({
      next: (result) => {
        delivered = true;
        release();
        deliver(result);
      },
      error: (error: unknown) => {
        release();
        deliver({ kind: 'error', error });
      },
      complete: () => {
        release();
        if (!delivered)
          deliver({
            kind: 'error',
            error: new Error('chat-box demand completed without a result'),
          });
      },
    });
    this.active = subscriber;
    // A cached page can synchronously request its successor. Trampoline
    // delivery within this turn rather than recursively growing the stack.
    // The scheduled notification remains owned by this subscriber.
    demand.pipe(take(1), observeOn(queueScheduler)).subscribe(subscriber);
  }

  cancel(): void {
    this.active?.unsubscribe();
    this.active = null;
    this.retrying = false;
  }
}
