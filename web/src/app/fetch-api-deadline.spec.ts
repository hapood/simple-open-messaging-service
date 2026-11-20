import { HttpEvent, HttpEventType, HttpHeaderResponse } from '@angular/common/http';
import { Subject } from 'rxjs';
import { withFetchApiDeadline } from './fetch-api-deadline';

describe('fetch API deadlines', () => {
  afterEach(() => vi.useRealTimers());
  it('limits headers and unsubscribes the transport', async () => {
    vi.useFakeTimers();
    const source = new Subject<HttpEvent<unknown>>();
    const error = vi.fn();
    withFetchApiDeadline(source, '/api/v1/test').subscribe({ error });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(error).toHaveBeenCalledOnce();
    expect(source.observed).toBe(false);
  });
  it('allows sustained responses beyond a total deadline but rejects stalled reads', async () => {
    vi.useFakeTimers();
    const source = new Subject<HttpEvent<unknown>>();
    const error = vi.fn();
    withFetchApiDeadline(source, '/api/v1/test').subscribe({ error });
    source.next(new HttpHeaderResponse({ status: 200 }));
    for (let loaded = 1; loaded <= 5; loaded++) {
      await vi.advanceTimersByTimeAsync(20_000);
      source.next({ type: HttpEventType.DownloadProgress, loaded });
    }
    expect(error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(error).toHaveBeenCalledOnce();
  });
});
