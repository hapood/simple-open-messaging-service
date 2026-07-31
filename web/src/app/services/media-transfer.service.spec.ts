import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MediaTransferService } from './media-transfer.service';

describe('MediaTransferService', () => {
  let service: MediaTransferService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    service = TestBed.inject(MediaTransferService);
  });

  const file = (name: string, size: number) =>
    new File([new Uint8Array(size)], name, { type: 'image/png' });

  it('aggregates active and failed transfers by thread', () => {
    service.start({
      clientMessageId: 'a',
      threadId: 10,
      kind: 'image',
      file: file('a.png', 3),
    });
    service.start({
      clientMessageId: 'b',
      threadId: 10,
      kind: 'image',
      file: file('b.png', 5),
    });
    service.fail('b');

    expect(service.summaryFor(10)).toEqual(
      jasmine.objectContaining({
        threadId: 10,
        uploading: 1,
        failed: 1,
        total: 2,
        bytes: 8,
      }),
    );
    expect(service.activeCount()).toBe(1);
    expect(service.failedCount()).toBe(1);
  });

  it('removes a successful task and restarts a failed retry in place', () => {
    service.start({
      clientMessageId: 'a',
      threadId: 10,
      kind: 'image',
      file: file('a.png', 3),
    });
    service.fail('a');
    service.start({
      clientMessageId: 'a',
      threadId: 10,
      kind: 'image',
      file: file('a.png', 3),
    });

    expect(service.summaryFor(10)?.uploading).toBe(1);
    expect(service.summaryFor(10)?.failed).toBe(0);

    service.complete('a');
    expect(service.summaryFor(10)).toEqual(
      jasmine.objectContaining({ uploading: 0, completed: 1, progress: 100 }),
    );
  });

  it('computes byte-weighted progress without allowing regressions', () => {
    service.start({
      clientMessageId: 'small',
      threadId: 10,
      kind: 'image',
      file: file('small.png', 100),
    });
    service.start({
      clientMessageId: 'large',
      threadId: 10,
      kind: 'video',
      file: file('large.mp4', 900),
    });

    service.progress('small', 100, 100);
    service.complete('small');
    service.progress('large', 400, 900);
    expect(service.summaryFor(10)).toEqual(
      jasmine.objectContaining({
        completed: 1,
        total: 2,
        loadedBytes: 500,
        bytes: 1000,
        progress: 50,
      }),
    );

    service.progress('large', 300, 900);
    expect(service.summaryFor(10)?.progress).toBe(50);
  });

  it('keeps the file-size denominator stable when multipart total includes overhead', () => {
    service.start({
      clientMessageId: 'image',
      threadId: 10,
      kind: 'image',
      file: file('image.png', 1000),
    });

    service.progress('image', 500, 1100);
    const first = service.summaryFor(10);
    expect(first?.bytes).toBe(1000);
    expect(first?.progress).toBe(45);

    service.progress('image', 880, 1100);
    const second = service.summaryFor(10);
    expect(second?.bytes).toBe(1000);
    expect(second?.progress).toBe(80);
  });

  it('emits a distinct latest-position request for repeated navigation', () => {
    service.requestLatest(42);
    const first = service.latestRequest();
    expect(first?.threadId).toBe(42);

    service.requestLatest(42);
    expect(service.latestRequest()).not.toBe(first);
  });

  it('cancels the active stream and exposes its retry action', () => {
    const retry = jasmine.createSpy('retry');
    let cancelled = 0;
    service.start({
      clientMessageId: 'a',
      threadId: 10,
      kind: 'image',
      file: file('a.png', 3),
    });
    service.registerRetry('a', retry);
    service.cancelled('a').subscribe(() => cancelled++);

    service.cancel('a');
    expect(cancelled).toBe(1);
    expect(service.summaryFor(10)?.failed).toBe(1);

    service.retry('a');
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not retry a permanent validation failure', () => {
    const retry = jasmine.createSpy('retry');
    service.start({
      clientMessageId: 'oversized',
      threadId: 10,
      kind: 'file',
      file: file('large.bin', 3),
    });
    service.registerRetry('oversized', retry);
    service.fail('oversized', 'too large', false);

    service.retry('oversized');

    expect(retry).not.toHaveBeenCalled();
    expect(service.tasks()[0].retryable).toBeFalse();
  });
});
