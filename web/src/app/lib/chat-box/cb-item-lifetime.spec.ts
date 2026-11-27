import { Observable } from 'rxjs';
import { firstValueFromAbortable } from '../async/cancellation-scope';
import { CbItemLifetime } from './cb-item-lifetime';

/** These fixtures intentionally control completion rather than relying on timers. */
describe('CbItemLifetime', () => {
  it('cancels activity immediately but retains presentation until final destruction', () => {
    const lifetime = new CbItemLifetime();
    const order: string[] = [];
    lifetime.signal.addEventListener('abort', () => {
      expect(lifetime.active).toBe(false);
      order.push('abort');
    });
    lifetime.onPredestory(() => order.push('unsubscribe'));
    lifetime.onDestroy(() => order.push('view'));
    lifetime.onDestroy(() => order.push('image'));

    lifetime.predestory();
    lifetime.predestory();
    expect(order).toEqual(['abort', 'unsubscribe']);
    expect(lifetime.signal.aborted).toBe(true);
    expect(lifetime.destroyed).toBe(false);

    lifetime.destroy();
    lifetime.destroy();
    lifetime.predestory();
    expect(order).toEqual(['abort', 'unsubscribe', 'view', 'image']);
    expect(lifetime.destroyed).toBe(true);
  });

  it('pre-destroys before final cleanup even without an animation', () => {
    const lifetime = new CbItemLifetime();
    const order: string[] = [];
    lifetime.onDestroy(() => order.push('view'));
    lifetime.onPredestory(() => order.push('request'));
    lifetime.destroy();
    expect(order).toEqual(['request', 'view']);
  });

  it('unsubscribes owned observable I/O without cancelling a sibling consumer', async () => {
    const first = new CbItemLifetime();
    const sibling = new CbItemLifetime();
    const cancelled = vi.fn();
    const io = () => new Observable<never>(() => cancelled);
    const firstResult = firstValueFromAbortable(io(), first.signal);
    const siblingResult = firstValueFromAbortable(io(), sibling.signal);
    const firstRejected = expect(firstResult).rejects.toMatchObject({
      name: 'AbortError',
    });
    const siblingRejected = expect(siblingResult).rejects.toMatchObject({
      name: 'AbortError',
    });
    first.predestory();
    await firstRejected;
    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(sibling.active).toBe(true);
    expect(sibling.signal.aborted).toBe(false);
    sibling.destroy();
    await siblingRejected;
    expect(cancelled).toHaveBeenCalledTimes(2);
    first.destroy();
  });

  it('immediately releases activity registered after retirement', () => {
    const lifetime = new CbItemLifetime();
    const activity = vi.fn();
    const image = vi.fn();
    lifetime.predestory();
    lifetime.onPredestory(activity);
    lifetime.onDestroy(image);
    expect(activity).toHaveBeenCalledOnce();
    expect(image).not.toHaveBeenCalled();
    lifetime.destroy();
    expect(image).toHaveBeenCalledOnce();
    const late = vi.fn();
    lifetime.onDestroy(late);
    expect(late).toHaveBeenCalledOnce();
  });

  it('allows an already-destroyed child to unregister its cleanup', () => {
    const lifetime = new CbItemLifetime();
    const childActivity = vi.fn();
    const childView = vi.fn();
    const detachActivity = lifetime.onPredestory(childActivity);
    const detachView = lifetime.onDestroy(childView);
    detachActivity();
    detachActivity();
    detachView();
    lifetime.destroy();
    expect(childActivity).not.toHaveBeenCalled();
    expect(childView).not.toHaveBeenCalled();
  });

  it('does not deduplicate independently registered resource releases', () => {
    const lifetime = new CbItemLifetime();
    const release = vi.fn();
    lifetime.onPredestory(release);
    lifetime.onPredestory(release);
    lifetime.onDestroy(release);
    lifetime.destroy();
    expect(release).toHaveBeenCalledTimes(3);
  });

  it('completes sibling activity cleanup even when one callback throws', () => {
    const lifetime = new CbItemLifetime();
    const error = new Error('unsubscribe failed');
    const sibling = vi.fn();
    const view = vi.fn();
    lifetime.onPredestory(() => { throw error; });
    lifetime.onPredestory(sibling);
    lifetime.onDestroy(view);
    expect(() => lifetime.predestory()).toThrow(AggregateError);
    expect(sibling).toHaveBeenCalledOnce();
    expect(view).not.toHaveBeenCalled();
    expect(lifetime.active).toBe(false);
    expect(() => lifetime.destroy()).not.toThrow();
    expect(view).toHaveBeenCalledOnce();
  });

  it('completes final destruction and reports all cleanup failures together', () => {
    const lifetime = new CbItemLifetime();
    const activityError = new Error('activity');
    const viewError = new Error('view');
    const image = vi.fn();
    lifetime.onPredestory(() => { throw activityError; });
    lifetime.onDestroy(() => { throw viewError; });
    lifetime.onDestroy(image);
    let caught: unknown;
    try {
      lifetime.destroy();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([activityError, viewError]);
    expect(image).toHaveBeenCalledOnce();
    expect(lifetime.destroyed).toBe(true);
    expect(() => lifetime.destroy()).not.toThrow();
  });

  it('defers reentrant destruction until every activity cleanup finishes', () => {
    const lifetime = new CbItemLifetime();
    const order: string[] = [];
    lifetime.onPredestory(() => {
      order.push('first');
      lifetime.destroy();
      expect(lifetime.destroyed).toBe(false);
    });
    lifetime.onPredestory(() => order.push('second'));
    lifetime.onDestroy(() => {
      order.push('view');
      lifetime.destroy();
    });
    lifetime.predestory();
    expect(order).toEqual(['first', 'second', 'view']);
    expect(lifetime.destroyed).toBe(true);
  });

  it('handles cleanup registered during abort and pre-destruction in the same drain', () => {
    const lifetime = new CbItemLifetime();
    const order: string[] = [];
    lifetime.signal.addEventListener('abort', () => {
      lifetime.onPredestory(() => order.push('abort registration'));
      lifetime.destroy();
    });
    lifetime.onPredestory(() => {
      order.push('first');
      lifetime.onPredestory(() => order.push('late activity'));
    });
    lifetime.onDestroy(() => order.push('view'));
    lifetime.predestory();
    expect(order).toEqual(['first', 'abort registration', 'late activity', 'view']);
  });

  it('revokes publication before unsubscribe invokes synchronous callbacks', () => {
    const lifetime = new CbItemLifetime();
    const publish = vi.fn();
    lifetime.onPredestory(() => {
      if (lifetime.active) publish();
    });
    lifetime.destroy();
    expect(publish).not.toHaveBeenCalled();
  });
});
