import { HttpEvent, HttpEventType, HttpHeaderResponse, HttpResponse } from '@angular/common/http';
import { Observable, Subject } from 'rxjs';
import { withXhrUploadDeadline } from './xhr-upload-deadline';

describe('XHR upload transport deadlines', () => {
  afterEach(() => vi.useRealTimers());
  it('times out and unsubscribes without any progress consumer', async () => {
    vi.useFakeTimers();
    const stopped = vi.fn();
    const error = vi.fn();
    withXhrUploadDeadline(new Observable<HttpEvent<unknown>>(() => stopped), '/upload').subscribe({ error });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(error).toHaveBeenCalledOnce();
    expect(stopped).toHaveBeenCalledOnce();
  });
  it('renews only on growing bytes and switches to the response deadline at upload completion', async () => {
    vi.useFakeTimers();
    const events = new Subject<HttpEvent<unknown>>();
    const error = vi.fn();
    withXhrUploadDeadline(events, '/upload').subscribe({ error });
    await vi.advanceTimersByTimeAsync(20_000);
    events.next({ type: HttpEventType.UploadProgress, loaded: 1, total: 2 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(error).not.toHaveBeenCalled();
    events.next({ type: HttpEventType.UploadProgress, loaded: 2, total: 2 });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(error).toHaveBeenCalledOnce();
  });
  it('does not extend upload inactivity on repeated byte counts', async () => {
    vi.useFakeTimers();
    const events = new Subject<HttpEvent<unknown>>();
    const error = vi.fn();
    withXhrUploadDeadline(events, '/upload').subscribe({ error });
    events.next({ type: HttpEventType.UploadProgress, loaded: 1, total: 10 });
    await vi.advanceTimersByTimeAsync(20_000);
    events.next({ type: HttpEventType.UploadProgress, loaded: 1, total: 10 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(error).toHaveBeenCalledOnce();
  });

  it('renews response-body inactivity and cleans up on completion', async () => {
    vi.useFakeTimers();
    const events = new Subject<HttpEvent<unknown>>();
    const error = vi.fn();
    const complete = vi.fn();
    withXhrUploadDeadline(events, '/upload').subscribe({ error, complete });
    events.next({ type: HttpEventType.UploadProgress, loaded: 10, total: 10 });
    events.next(new HttpHeaderResponse({ status: 200 }));
    await vi.advanceTimersByTimeAsync(20_000);
    events.next({ type: HttpEventType.DownloadProgress, loaded: 5 });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(error).not.toHaveBeenCalled();
    events.next(new HttpResponse({ body: {}, status: 200 }));
    events.complete();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
  });

  it('clears the deadline when cancelled', async () => {
    vi.useFakeTimers();
    const error = vi.fn();
    const subscription = withXhrUploadDeadline(new Subject<HttpEvent<unknown>>(), '/upload').subscribe({ error });
    subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(error).not.toHaveBeenCalled();
  });
});
