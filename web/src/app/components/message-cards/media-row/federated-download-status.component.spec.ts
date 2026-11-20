import { TestBed } from '@angular/core/testing';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { FederatedDownloadStatusComponent } from './federated-download-status.component';
import { MEDIA_STATUS } from '../chat-item';

afterEach(() => {
  TestBed.resetTestingModule();
  vi.restoreAllMocks();
});
describe('federated download completion', () => {
  function setup(reduced = false) {
    const motion = new EventTarget();
    const remove = vi.spyOn(motion, 'removeEventListener');
    vi.spyOn(window, 'matchMedia').mockReturnValue(
      Object.assign(motion, { matches: reduced }) as MediaQueryList,
    );
    const animations: {
      cancel: ReturnType<typeof vi.fn>;
      onfinish: (() => void) | null;
    }[] = [];
    const animate = vi
      .spyOn(Element.prototype, 'animate')
      .mockImplementation(() => {
        const animation = { cancel: vi.fn(), onfinish: null };
        animations.push(animation);
        return animation as unknown as Animation;
      });
    const fixture = TestBed.createComponent(FederatedDownloadStatusComponent);
    const update = (status: string, id = 1) => {
      fixture.componentRef.setInput('messageId', id);
      fixture.componentRef.setInput('status', status);
      fixture.detectChanges();
    };
    return { fixture, update, animations, animate, motion, remove };
  }

  it('renders the real ring-to-check crossfade and leaves no finished effects', async () => {
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const fixture = TestBed.createComponent(FederatedDownloadStatusComponent);
    fixture.componentRef.setInput('messageId', 1);
    fixture.componentRef.setInput('status', MEDIA_STATUS.DOWNLOADING);
    fixture.detectChanges();
    fixture.componentRef.setInput('status', MEDIA_STATUS.READY);
    fixture.detectChanges();
    const icon = fixture.nativeElement.querySelector('span') as HTMLElement;
    const ring = icon.querySelector('circle')!;
    const check = icon.querySelector('path')!;
    const animations = icon.getAnimations({ subtree: true });
    expect(animations).toHaveLength(3);
    for (const animation of animations) {
      animation.pause();
      animation.currentTime = 200;
    }
    expect(Number(getComputedStyle(icon).opacity)).toBe(1);
    expect(Number(getComputedStyle(ring).opacity)).toBeCloseTo(0.5, 1);
    expect(Number(getComputedStyle(check).opacity)).toBeGreaterThan(0);
    expect(Number(getComputedStyle(check).opacity)).toBeLessThan(1);
    const finished = new Promise<void>((resolve) =>
      animations[0].addEventListener('finish', () => resolve(), { once: true }),
    );
    animations[0].finish();
    await finished;
    expect(icon.getAnimations({ subtree: true })).toHaveLength(0);
    expect(getComputedStyle(icon).opacity).toBe('0');
    fixture.destroy();
  });

  it('does not treat a replacement message as a completed download', () => {
    const { update, animate } = setup();
    update(MEDIA_STATUS.DOWNLOADING);
    update(MEDIA_STATUS.READY, 2);
    expect(animate).not.toHaveBeenCalled();
  });

  it('skips completion animation when reduced motion is already enabled', () => {
    const { update, animate } = setup(true);
    update(MEDIA_STATUS.DOWNLOADING);
    update(MEDIA_STATUS.READY);
    expect(animate).not.toHaveBeenCalled();
  });

  it('cancels active animation on motion preference change and releases its listener', () => {
    const { update, animations, motion, fixture, remove } = setup();
    update(MEDIA_STATUS.DOWNLOADING);
    update(MEDIA_STATUS.READY);
    motion.dispatchEvent(new Event('change'));
    expect(animations).toHaveLength(3);
    for (const animation of animations)
      expect(animation.cancel).toHaveBeenCalledOnce();
    fixture.destroy();
    expect(remove).toHaveBeenCalledWith('change', expect.any(Function));
  });

  it('releases all animation effects on completion and does not replay on unchanged status', () => {
    const { update, animations, animate } = setup();
    update(MEDIA_STATUS.DOWNLOADING);
    update(MEDIA_STATUS.READY);
    animations[0].onfinish!();
    for (const animation of animations)
      expect(animation.cancel).toHaveBeenCalledOnce();
    update(MEDIA_STATUS.READY);
    expect(animate).toHaveBeenCalledTimes(3);
  });

  it('cancels completion when the same message begins downloading again', () => {
    const { update, animations } = setup();
    update(MEDIA_STATUS.DOWNLOADING);
    update(MEDIA_STATUS.READY);
    update(MEDIA_STATUS.DOWNLOADING);
    for (const animation of animations)
      expect(animation.cancel).toHaveBeenCalledOnce();
  });

  it('animates only a live completion of the same message and cancels on destruction', () => {
    const cancel = vi.fn();
    const animate = vi
      .spyOn(Element.prototype, 'animate')
      .mockImplementation(
        () => ({ cancel, onfinish: null }) as unknown as Animation,
      );
    vi.spyOn(window, 'matchMedia').mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    const fixture = TestBed.createComponent(FederatedDownloadStatusComponent);
    fixture.componentRef.setInput('messageId', 1);
    const setStatus = (status: string) => {
      fixture.componentRef.setInput('status', status);
      fixture.detectChanges();
    };
    setStatus(MEDIA_STATUS.READY);
    expect(animate).not.toHaveBeenCalled();
    setStatus(MEDIA_STATUS.DOWNLOADING);
    setStatus(MEDIA_STATUS.FAILED);
    expect(animate).not.toHaveBeenCalled();
    setStatus(MEDIA_STATUS.DOWNLOADING);
    setStatus(MEDIA_STATUS.READY);
    expect(animate).toHaveBeenCalledTimes(3);
    fixture.destroy();
    expect(cancel).toHaveBeenCalledTimes(3);
  });
});
