import { Subscription } from 'rxjs';
import { BoundedRequestScheduler } from '../lib/bounded-request-scheduler';
import { fetchShortText } from '../lib/short-fetch';

/** One instance belongs to the database worker, independently of the main thread.
 * Domain admission limits remain upstream; this lane owns only HTTP transport.
 */
export class WorkerShortJsonTransport {
  private readonly scheduler = new BoundedRequestScheduler(8);

  request<T = unknown>(
    url: string,
    init: RequestInit,
    errorLabel: string,
  ): Promise<T> {
    const owner = init.signal;
    return new Promise<T>((resolve, reject) => {
      const subscription = new Subscription();
      const abort = () => {
        subscription.unsubscribe();
        owner?.removeEventListener('abort', abort);
        reject(owner?.reason);
      };
      if (owner?.aborted) {
        abort();
        return;
      }
      owner?.addEventListener('abort', abort, { once: true });
      subscription.add(
        this.scheduler
          .schedule((signal) => fetchJson<T>(url, init, errorLabel, signal))
          .subscribe({
            next: resolve,
            error: (error: unknown) => {
              owner?.removeEventListener('abort', abort);
              reject(error);
            },
            complete: () => owner?.removeEventListener('abort', abort),
          }),
      );
    });
  }
}

async function fetchJson<T>(
  url: string,
  init: RequestInit,
  errorLabel: string,
  signal: AbortSignal,
): Promise<T> {
  const { response, text } = await fetchShortText(url, init, signal);
  // Drain error bodies too, without replacing the endpoint's HTTP error with a
  // JSON syntax error (an upstream error page need not contain JSON).
  if (!response.ok) throw new Error(`${errorLabel} HTTP ${response.status}`);
  return JSON.parse(text) as T;
}
