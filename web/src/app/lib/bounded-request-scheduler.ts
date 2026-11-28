import { Observable } from 'rxjs';

/** FIFO admission for promise-backed transports. Aborting an observer does not release
 * its slot: the transport must settle (including body consumption) first. */
export class BoundedRequestScheduler {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error('Invalid request limit');
  }

  schedule<T>(
    run: (signal: AbortSignal, emit: (event: T) => void) => Promise<T>,
  ): Observable<T> {
    return new Observable<T>((subscriber) => {
      let started = false;
      let settled = false;
      const controller = new AbortController();
      const start = () => {
        started = true;
        this.active++;
        // Defer the transport so synchronous unsubscribe cannot dispatch it.
        void Promise.resolve()
          .then(() => {
            if (controller.signal.aborted) throw controller.signal.reason;
            return run(controller.signal, (event) => subscriber.next(event));
          })
          .then(
            (value) => {
              settled = true;
              subscriber.next(value);
              subscriber.complete();
            },
            (error) => {
              settled = true;
              subscriber.error(error);
            },
          )
          .finally(() => {
            this.active--;
            this.drain();
          });
      };
      this.queue.push(start);
      this.drain();
      return () => {
        if (settled) return;
        if (started) controller.abort();
        else {
          const index = this.queue.indexOf(start);
          if (index !== -1) this.queue.splice(index, 1);
        }
      };
    });
  }

  private drain(): void {
    while (this.active < this.limit && this.queue.length)
      this.queue.shift()?.();
  }
}

/** One lane per browser JS runtime, not per component or injector. Worker fetches
 * and native IPC have separate owners and do not participate in this lane. */
export const browserShortRequestScheduler = new BoundedRequestScheduler(8);
