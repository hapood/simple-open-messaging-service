import { firstValueFrom, Observable, takeUntil } from 'rxjs';

/** A consumer's cancellable lifetime. Parent cancellation is forwarded without
 * cancelling the parent or other consumers. Always dispose to release listeners. */
export class CancellationScope {
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly detach: Array<() => void> = [];

  constructor(...parents: Array<AbortSignal | undefined>) {
    for (const parent of parents) {
      if (!parent) continue;
      const abort = () => this.cancel(parent.reason);
      if (parent.aborted) {
        abort();
        break;
      }
      parent.addEventListener('abort', abort, { once: true });
      this.detach.push(() => parent.removeEventListener('abort', abort));
    }
  }

  cancel(
    reason: unknown = new DOMException('Operation cancelled', 'AbortError'),
  ): void {
    this.controller.abort(reason);
    this.dispose();
  }

  dispose(): void {
    for (const detach of this.detach.splice(0)) detach();
  }
}

/** Unsubscribe owned observable work (including Angular HTTP) on cancellation.
 * The abort reason is an error, never an empty successful response. */
export function firstValueFromAbortable<T>(
  source: Observable<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  const aborted = new Observable<never>((subscriber) => {
    const abort = () => subscriber.error(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener('abort', abort);
  });
  return firstValueFrom(source.pipe(takeUntil(aborted)));
}

/** Detach from non-abortable/shared work without cancelling its owner.
 * Both fulfillment and rejection stay observed after this consumer cancels. */
export function awaitAbortable<T>(
  work: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
