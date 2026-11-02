import { describe, expect, it, vi } from 'vitest';
import { Observable, of, Subject } from 'rxjs';
import { EdgeDemandState } from './edge-demand-state';
import type { CbDemandResult } from './cb-source';

describe('EdgeDemandState', () => {
  it('unsubscribes before handing a result to a callback that starts a successor', () => {
    const edge = new EdgeDemandState<number>();
    const next = new Subject<CbDemandResult<number>>();
    const deliver = vi.fn();
    edge.subscribe(of({ kind: 'boundary' }), () => {
      expect(edge.active).toBeNull();
      edge.subscribe(next, deliver);
    });
    expect(next.observed).toBe(true);
    edge.cancel();
    expect(next.observed).toBe(false);
    next.next({ kind: 'boundary' });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('cancels delivery and releases the source immediately', () => {
    const edge = new EdgeDemandState<number>();
    const release = vi.fn();
    let publish!: () => void;
    const deliver = vi.fn();
    edge.subscribe(
      new Observable((subscriber) => {
        publish = () => subscriber.next({ kind: 'boundary' });
        return release;
      }),
      deliver,
    );
    edge.cancel();
    expect(release).toHaveBeenCalledOnce();
    publish();
    expect(deliver).not.toHaveBeenCalled();
  });

  it('drains synchronous successor pages without nesting delivery callbacks', () => {
    const edge = new EdgeDemandState<number>();
    let depth = 0;
    let maximumDepth = 0;
    let delivered = 0;
    const deliver = () => {
      depth++;
      maximumDepth = Math.max(maximumDepth, depth);
      delivered++;
      if (delivered < 30) edge.subscribe(of({ kind: 'boundary' }), deliver);
      depth--;
    };
    edge.subscribe(of({ kind: 'boundary' }), deliver);
    expect(delivered).toBe(30);
    expect(maximumDepth).toBe(1);
    expect(edge.active).toBeNull();
  });

  it('cancels a queued synchronous successor before it can deliver', () => {
    const edge = new EdgeDemandState<number>();
    const successor = vi.fn();
    edge.subscribe(of({ kind: 'boundary' }), () => {
      edge.subscribe(of({ kind: 'boundary' }), successor);
      edge.cancel();
    });
    expect(successor).not.toHaveBeenCalled();
    expect(edge.active).toBeNull();
  });

  it('reports an empty completion as an error, not a history boundary', () => {
    const edge = new EdgeDemandState<number>();
    const deliver = vi.fn();
    edge.subscribe(
      new Observable((subscriber) => subscriber.complete()),
      deliver,
    );
    expect(deliver).toHaveBeenCalledExactlyOnceWith({
      kind: 'error',
      error: expect.any(Error),
    });
    expect(edge.active).toBeNull();
  });
});
