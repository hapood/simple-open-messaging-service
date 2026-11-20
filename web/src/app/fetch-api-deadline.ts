import { HttpErrorResponse, HttpEvent, HttpEventType } from '@angular/common/http';
import { Observable } from 'rxjs';

/** API receive deadlines. Unsubscription aborts Angular's underlying fetch. */
export function withFetchApiDeadline<T>(source: Observable<HttpEvent<T>>, url: string): Observable<HttpEvent<T>> {
  return new Observable(subscriber => {
    let loaded = 0;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => subscriber.error(new HttpErrorResponse({
        status: 0, statusText: 'HTTP transport timed out', url,
        error: new DOMException('HTTP transport timed out', 'TimeoutError'),
      })), delay);
    };
    arm(12_000);
    const subscription = source.subscribe({
      next(event) {
        if (event.type === HttpEventType.ResponseHeader) arm(30_000);
        else if (event.type === HttpEventType.DownloadProgress && event.loaded > loaded) {
          loaded = event.loaded;
          arm(30_000);
        }
        subscriber.next(event);
      },
      error: error => subscriber.error(error),
      complete: () => subscriber.complete(),
    });
    return () => { clearTimeout(timer); subscription.unsubscribe(); };
  });
}
