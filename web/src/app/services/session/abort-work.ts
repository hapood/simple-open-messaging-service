import { MonoTypeOperatorFunction, Observable, takeUntil } from 'rxjs';
import { SessionSupersededError } from './session-identity';

/** Abort is an error, not successful completion; unsubscribe the entire work/retry chain. */
export function abortWork<T>(signal: AbortSignal): MonoTypeOperatorFunction<T> {
  return takeUntil(
    new Observable<never>((subscriber) => {
      const abort = () => subscriber.error(new SessionSupersededError());
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      return () => signal.removeEventListener('abort', abort);
    }),
  );
}
