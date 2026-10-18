import { Observable, firstValueFrom, takeUntil, timeout } from 'rxjs';
import { SessionSupersededError } from './session-identity';

/** Unsubscribing aborts Angular's actual HTTP backend, not just response publication. */
export function sessionRequest<T>(
  source: Observable<T>,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  const cancelled = new Observable<never>((subscriber) => {
    const abort = () => subscriber.error(new SessionSupersededError());
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    return () => signal.removeEventListener('abort', abort);
  });
  let request = source.pipe(takeUntil(cancelled));
  if (timeoutMs !== undefined)
    request = request.pipe(timeout({ first: timeoutMs }));
  return firstValueFrom(request);
}
