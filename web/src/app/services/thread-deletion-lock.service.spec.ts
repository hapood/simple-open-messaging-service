import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ThreadDeletionLockService } from './thread-deletion-lock.service';

describe('ThreadDeletionLockService', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    });
  });

  it('locks once and emits release only after the matching lock is removed', () => {
    const service = TestBed.inject(ThreadDeletionLockService);
    const released: number[] = [];
    service.released$.subscribe((threadId) => released.push(threadId));

    expect(service.begin(7)).toBe(true);
    expect(service.begin(7)).toBe(false);
    expect(service.has(7)).toBe(true);
    service.end(8);
    expect(released).toEqual([]);
    service.end(7);
    expect(service.has(7)).toBe(false);
    expect(released).toEqual([7]);
  });
});
