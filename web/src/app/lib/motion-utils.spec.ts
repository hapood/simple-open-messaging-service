import { InterruptibleMotion, springGradient } from './motion-utils';

const nextFrame = (): Promise<void> => new Promise((resolve) =>
  requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
);

describe('InterruptibleMotion', () => {
  let el: HTMLDivElement;
  let owner: InterruptibleMotion;

  beforeEach(() => {
    el = document.createElement('div');
    el.style.opacity = '1';
    el.style.transform = 'scale(1)';
    document.body.append(el);
    owner = new InterruptibleMotion();
  });

  afterEach(() => {
    owner.destroy();
    el.remove();
    vi.restoreAllMocks();
  });

  it('samples before cancelling and ignores a superseded completion', async () => {
    const oldComplete = vi.fn();
    const newComplete = vi.fn();
    owner.retarget(el, { opacity: 0, transform: 'scale(0.9)' }, { duration: 1, onComplete: oldComplete });
    await nextFrame();
    const old = el.getAnimations();
    expect(old).toHaveLength(1);
    for (const animation of old) {
      animation.pause();
      animation.currentTime = 450;
    }
    const opacity = getComputedStyle(el).opacity;
    const transform = getComputedStyle(el).transform;
    owner.retarget(el, { opacity: 1, transform: 'scale(1)' }, { duration: 1, onComplete: newComplete });
    expect(old.every((animation) => animation.playState === 'idle')).toBe(true);
    await nextFrame();
    const current = el.getAnimations();
    const frames = current.flatMap((animation) => animation.effect instanceof KeyframeEffect ? [animation.effect.getKeyframes()[0]] : []);
    expect(frames.find((frame) => frame['opacity'] !== undefined)?.['opacity']).toBe(opacity);
    expect(frames.find((frame) => frame['transform'] !== undefined)?.['transform']).toBe(transform);
    for (const animation of current) animation.finish();
    await nextFrame();
    expect(oldComplete).not.toHaveBeenCalled();
    expect(newComplete).toHaveBeenCalledOnce();
    expect(el.style.opacity).toBe('1');
    expect(el.style.transform).toBe('scale(1)');
    expect(el.getAnimations()).toHaveLength(0);
  });

  it('invalidates already queued completions on retarget and destruction', async () => {
    const stale = vi.fn();
    owner.retarget(el, { opacity: 0 }, { duration: 1, onComplete: stale });
    await nextFrame();
    for (const animation of el.getAnimations()) animation.finish();
    owner.retarget(el, { opacity: 1 }, { duration: 0 });
    await nextFrame();
    expect(stale).not.toHaveBeenCalled();
    expect(el.style.opacity).toBe('1');
    owner.retarget(el, { opacity: 0 }, { duration: 1, onComplete: stale });
    await nextFrame();
    const running = el.getAnimations();
    owner.destroy();
    await nextFrame();
    expect(running.every((animation) => animation.playState === 'idle')).toBe(true);
    expect(stale).not.toHaveBeenCalled();
    owner.retarget(el, { opacity: 1 }, { duration: 1 });
    expect(el.getAnimations()).toHaveLength(0);
  });

  it('settles active motion when reduced motion changes and snaps subsequent gradient targets', async () => {
    owner.destroy();
    const media = matchMedia('(prefers-reduced-motion: reduce)');
    const matches = vi.spyOn(media, 'matches', 'get').mockReturnValue(false);
    vi.spyOn(window, 'matchMedia').mockReturnValue(media);
    owner = new InterruptibleMotion();
    const complete = vi.fn();
    owner.retarget(el, { opacity: 0 }, { duration: 1, onComplete: complete });
    await nextFrame();
    matches.mockReturnValue(true);
    media.dispatchEvent(new Event('change'));
    expect(el.getAnimations()).toHaveLength(0);
    expect(el.style.opacity).toBe('0');
    expect(complete).toHaveBeenCalledOnce();
    el.style.setProperty('--palette-from', 'rgb(10, 20, 30)');
    el.style.setProperty('--palette-to', 'rgb(30, 40, 50)');
    el.style.setProperty('--palette-icon', 'rgb(60, 70, 80)');
    springGradient(owner, el, { from: '--palette-from', to: '--palette-to', ic: '--palette-icon' });
    expect(el.style.getPropertyValue('--g-from')).toBe('rgb(10, 20, 30)');
    expect(el.style.getPropertyValue('--g-to')).toBe('rgb(30, 40, 50)');
    expect(el.style.getPropertyValue('--ic')).toBe('rgb(60, 70, 80)');
    expect(el.getAnimations()).toHaveLength(0);
  });
});
