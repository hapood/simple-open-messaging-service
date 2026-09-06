import { BehaviorSubject, Subject, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { HttpClient } from '@angular/common/http';
import type { WebsocketService } from './websocket.service';
import { QuoteResolutionService } from './quote-resolution.service';

describe('mounted quote resolution', () => {
  const ws = () => ({
    eventSubject: new Subject<unknown>(),
    helloReady$: new BehaviorSubject(true),
    helloGeneration$: new BehaviorSubject(1),
  });
  it('does not resubmit a failed request on an immediate remount', async () => {
    const realtime = ws();
    const post = vi.fn().mockReturnValue(of({ code: 1, message: 'offline' }));
    const service = new QuoteResolutionService(
      { post } as unknown as HttpClient,
      realtime as unknown as WebsocketService,
    );
    await expect(
      firstValueFrom(service.resolve({ threadId: 7, messageSeq: 9 })),
    ).rejects.toThrow('offline');
    await expect(
      firstValueFrom(service.resolve({ threadId: 7, messageSeq: 9 })),
    ).rejects.toThrow('offline');
    expect(post).toHaveBeenCalledTimes(1);
  });
  it('uses the shared SSE connection for pending results', async () => {
    const realtime = ws();
    const post = vi
      .fn()
      .mockReturnValue(
        of({ code: 0, data: { status: 'PENDING', requestId: 'q1' } }),
      );
    const service = new QuoteResolutionService(
      { post } as unknown as HttpClient,
      realtime as unknown as WebsocketService,
    );
    const result = firstValueFrom(
      service.resolve({ threadId: 7, messageSeq: 9 }),
    );
    await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    realtime.eventSubject.next({
      event: 'QUOTE_RESOLVED',
      status: 0,
      data: { requestId: 'q1', result: { seq: 0, status: 'NOT_FOUND' } },
    });
    expect(await result).toEqual({ seq: 0, status: 'NOT_FOUND' });
  });
});
