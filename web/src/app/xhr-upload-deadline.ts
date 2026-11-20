import { HttpErrorResponse, HttpEvent, HttpEventType } from '@angular/common/http';
import { Observable } from 'rxjs';

const UPLOAD_IDLE_MS = 30_000;
const RESPONSE_HEADERS_MS = 12_000;
const RESPONSE_BODY_IDLE_MS = 30_000;

/** Applies to one XHR upload attempt. Teardown unsubscribes the backend and aborts its request. */
export function withXhrUploadDeadline<T>(source: Observable<HttpEvent<T>>, url: string): Observable<HttpEvent<T>> {
  return new Observable(subscriber => {
    let loaded = 0;
    let receiving = false;
    let timer: ReturnType<typeof setTimeout>;
    const arm = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => subscriber.error(new HttpErrorResponse({
        status: 0, statusText: 'Upload transport timed out', url,
        error: new DOMException('Upload transport timed out', 'TimeoutError'),
      })), delay);
    };
    arm(UPLOAD_IDLE_MS);
    const subscription = source.subscribe({
      next(event) {
        if (event.type === HttpEventType.UploadProgress && event.loaded > loaded) {
          loaded = event.loaded;
          arm(event.total !== undefined && loaded >= event.total ? RESPONSE_HEADERS_MS : UPLOAD_IDLE_MS);
        } else if (event.type === HttpEventType.ResponseHeader) {
          receiving = true;
          loaded = 0;
          arm(RESPONSE_BODY_IDLE_MS);
        } else if (event.type === HttpEventType.DownloadProgress && receiving && event.loaded > loaded) {
          loaded = event.loaded;
          arm(RESPONSE_BODY_IDLE_MS);
        }
        subscriber.next(event);
      },
      error: error => subscriber.error(error),
      complete: () => subscriber.complete(),
    });
    return () => { clearTimeout(timer); subscription.unsubscribe(); };
  });
}
