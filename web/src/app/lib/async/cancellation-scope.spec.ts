import { Observable } from 'rxjs';
import {
  CancellationScope,
  awaitAbortable,
  firstValueFromAbortable,
} from './cancellation-scope';

describe('CancellationScope', () => {
  it('forwards parent cancellation without cancelling siblings', () => {
    const parent = new AbortController();
    const first = new CancellationScope(parent.signal);
    const second = new CancellationScope(parent.signal);
    first.cancel();
    expect(parent.signal.aborted).toBe(false);
    expect(second.signal.aborted).toBe(false);
    parent.abort();
    expect(second.signal.aborted).toBe(true);
  });

  it('unsubscribes owned observable work and refuses already aborted work', async () => {
    const scope = new CancellationScope();
    const unsubscribe = vi.fn();
    const subscribe = vi.fn(() => unsubscribe);
    const source = new Observable(subscribe);
    const pending = firstValueFromAbortable(source, scope.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    scope.cancel();
    await rejected;
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(() => firstValueFromAbortable(source, scope.signal)).toThrow();
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it('detaches from shared promises while observing their late rejection', async () => {
    const scope = new CancellationScope();
    let fail!: (error: Error) => void;
    const work = new Promise<never>((_resolve, reject) => {
      fail = reject;
    });
    const pending = awaitAbortable(work, scope.signal);
    const rejected = expect(pending).rejects.toMatchObject({
      name: 'AbortError',
    });
    scope.cancel();
    await rejected;
    fail(new Error('late failure'));
    await Promise.resolve();
  });
});
