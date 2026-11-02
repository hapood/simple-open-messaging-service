import { ChatSurfaceLifecycle } from './chat-surface-lifecycle';

describe('ChatSurfaceLifecycle synchronous stream', () => {
  it('revokes binding and cancels before synchronously notifying unbound', () => {
    const owner = new ChatSurfaceLifecycle();
    const binding = owner.bind(42);
    const order: string[] = [];
    binding.signal.addEventListener('abort', () => {
      expect(owner.binding).toBeUndefined();
      order.push('abort');
    });
    owner.state$.subscribe((state) => {
      if (state.phase === 'unbound') {
        expect(binding.signal.aborted).toBe(true);
        order.push('unbound');
      }
    });
    owner.unbind();
    expect(order).toEqual(['abort', 'unbound']);
    owner.unbind();
    expect(order).toHaveLength(2);
  });

  it('delivers unbind synchronously to every capability before returning', () => {
    const owner = new ChatSurfaceLifecycle();
    owner.bind(42);
    const kernelCleanup = vi.fn();
    const composerCleanup = vi.fn();
    owner.state$.subscribe((state) => {
      if (state.phase === 'unbound') kernelCleanup();
    });
    owner.state$.subscribe((state) => {
      if (state.phase === 'unbound') composerCleanup();
    });
    owner.unbind();
    expect(kernelCleanup).toHaveBeenCalledOnce();
    expect(composerCleanup).toHaveBeenCalledOnce();
  });

  it('replays state, separates foreground from binding, and lets only an un-aborted scope activate', () => {
    const owner = new ChatSurfaceLifecycle();
    const old = owner.bind(42);
    owner.unbind();
    const current = owner.bind(42);
    owner.activate(old, true);
    expect(owner.state()).toMatchObject({ phase: 'bound', foreground: false });
    owner.activate(current, true);
    const observed: unknown[] = [];
    owner.state$.subscribe((state) => observed.push(state));
    expect(observed).toEqual([
      { phase: 'bound', binding: current, foreground: true },
    ]);
    expect(old.signal.aborted).toBe(true);
    expect(current.signal.aborted).toBe(false);
    owner.destroy();
    expect(current.signal.aborted).toBe(true);
    expect(() => owner.bind(42)).toThrow();
  });
});
