import { describe, expect, it, vi } from 'vitest';
import { Observable, of, Subject } from 'rxjs';
import type { CbDemandResult } from './cb-source';
import { EntryDemandOwner } from './entry-demand-owner';

describe('EntryDemandOwner', () => {
  it('is single-flight and releases ownership before successful delivery', () => {
    const response = new Subject<CbDemandResult<number>>();
    const request = vi.fn(() => response);
    const owner = new EntryDemandOwner(request);
    const deliver = vi.fn(() => {
      expect(owner.ownsLocation).toBe(false);
      owner.start(deliver);
    });
    owner.start(deliver);
    owner.start(deliver);
    expect(owner.loading).toBe(true);
    expect(request).toHaveBeenCalledOnce();
    response.next({ kind: 'items', items: [] });
    expect(deliver).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(response.observed).toBe(false);
    owner.retry(deliver);
    expect(request).toHaveBeenCalledOnce();
  });

  it('retains the same opportunity after an error and only retries explicitly', () => {
    const error = new Error('offline');
    const request = vi
      .fn()
      .mockReturnValueOnce(of({ kind: 'error', error }))
      .mockReturnValueOnce(of({ kind: 'items', items: [] }));
    const owner = new EntryDemandOwner<number>(request);
    const deliver = vi.fn();
    owner.start(deliver);
    expect(owner.ownsLocation).toBe(true);
    expect(owner.loading).toBe(false);
    expect(owner.error).toBe(error);
    owner.start(deliver);
    expect(request).toHaveBeenCalledOnce();
    owner.retry(deliver);
    expect(request).toHaveBeenCalledTimes(2);
    expect(owner.ownsLocation).toBe(false);
    expect(owner.error).toBeNull();
  });

  it.each(['before start', 'during request', 'after failure'] as const)(
    'logical removal %s permanently consumes the opportunity',
    (when) => {
      const response = new Subject<CbDemandResult<number>>();
      const request = vi.fn(() => response);
      const owner = new EntryDemandOwner(request);
      const deliver = vi.fn();
      if (when !== 'before start') owner.start(deliver);
      if (when === 'after failure')
        response.next({ kind: 'error', error: new Error('offline') });
      const calls = deliver.mock.calls.length;
      owner.retire();
      expect(response.observed).toBe(false);
      response.next({ kind: 'items', items: [{ id: 10, data: 10 }] });
      owner.start(deliver);
      owner.retry(deliver);
      expect(deliver).toHaveBeenCalledTimes(calls);
      expect(request).toHaveBeenCalledTimes(when === 'before start' ? 0 : 1);
      expect(owner.ownsLocation).toBe(false);
      expect(owner.error).toBeNull();
    },
  );

  it('does not treat repeated presentation checks as removal', () => {
    const response = new Subject<CbDemandResult<number>>();
    const owner = new EntryDemandOwner(() => response);
    const deliver = vi.fn();
    owner.start(deliver);
    for (let i = 0; i < 5; i++) {
      expect(owner.ownsLocation).toBe(true);
      expect(owner.loading).toBe(true);
      owner.start(deliver);
    }
    response.next({ kind: 'boundary' });
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ kind: 'boundary' });
  });

  it('turns thrown request construction into a retryable error', () => {
    const error = new Error('request failed');
    const owner = new EntryDemandOwner<number>(() => {
      throw error;
    });
    const deliver = vi.fn();
    owner.start(deliver);
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ kind: 'error', error });
    expect(owner.error).toBe(error);
  });

  it('releases request resources before the delivery callback', () => {
    const released = vi.fn();
    let publish!: () => void;
    const owner = new EntryDemandOwner<number>(
      () =>
        new Observable((subscriber) => {
          publish = () => subscriber.next({ kind: 'items', items: [] });
          return released;
        }),
    );
    owner.start(() => expect(released).toHaveBeenCalledOnce());
    publish();
  });
});
