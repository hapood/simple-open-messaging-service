import { TestBed } from '@angular/core/testing';
import { ThreadDeletionLockService } from './thread-deletion-lock.service';

describe('ThreadDeletionLockService', () => {
  it('locks once and emits release only after the matching lock is removed', () => {
    const service = TestBed.inject(ThreadDeletionLockService);
    const released: number[] = [];
    service.released$.subscribe((threadId) => released.push(threadId));

    expect(service.begin(7)).toBeTrue();
    expect(service.begin(7)).toBeFalse();
    expect(service.has(7)).toBeTrue();
    service.end(8);
    expect(released).toEqual([]);
    service.end(7);
    expect(service.has(7)).toBeFalse();
    expect(released).toEqual([7]);
  });
});
