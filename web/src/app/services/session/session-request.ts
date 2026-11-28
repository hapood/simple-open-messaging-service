import { Observable, firstValueFrom, timeout } from 'rxjs';
import { abortWork } from './abort-work';

/** Unsubscribing aborts Angular's actual HTTP backend, not just response publication. */
export function sessionRequest<T>(
  source: Observable<T>,
  signal: AbortSignal,
  timeoutMs?: number,
): Promise<T> {
  let request = source.pipe(abortWork(signal));
  if (timeoutMs !== undefined)
    request = request.pipe(timeout({ first: timeoutMs }));
  return firstValueFrom(request);
}
