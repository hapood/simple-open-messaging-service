import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { AttachmentUploadQueueService } from './attachment-upload-queue.service';
import { PreferenceStore } from './preference-store.service';

describe('AttachmentUploadQueueService', () => {
  let service: AttachmentUploadQueueService;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
    await TestBed.inject(PreferenceStore).remove(
      'device',
      'soms.maxConcurrentUploads',
    );
    service = TestBed.inject(AttachmentUploadQueueService);
  });

  it('runs only one upload at a time for the same thread', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));

    const first = service.enqueue(10, async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = service.enqueue(10, async () => {
      order.push('second:start');
    });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start']);
  });

  it('shares the configured global slots across different threads', async () => {
    service.setMaxConcurrent(2);
    const active = new Set<number>();
    let peak = 0;
    const releases = new Map<number, () => void>();

    const jobs = [10, 20, 30].map((threadId) =>
      service.enqueue(threadId, async () => {
        active.add(threadId);
        peak = Math.max(peak, active.size);
        await new Promise<void>((resolve) => releases.set(threadId, resolve));
        active.delete(threadId);
      }),
    );

    await Promise.resolve();
    expect([...active].sort()).toEqual([10, 20]);
    releases.get(10)!();
    await jobs[0];
    await Promise.resolve();
    expect(active.has(30)).toBe(true);
    releases.get(20)!();
    releases.get(30)!();
    await Promise.all(jobs);
    expect(peak).toBe(2);
  });

  it('persists and clamps the maximum concurrency', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    service.setMaxConcurrent(6);
    expect(service.maxConcurrent()).toBe(6);
    expect(await preferences.get('device', 'soms.maxConcurrentUploads')).toBe(
      6,
    );

    service.setMaxConcurrent(99);
    expect(service.maxConcurrent()).toBe(8);
  });
});
