import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { FlipCountComponent } from './flip-count.component';

describe('FlipCountComponent', () => {
  it('renders the latest capped value without remounting the counter', async () => {
    const fixture = TestBed.createComponent(FlipCountComponent);
    fixture.componentRef.setInput('animate', false);
    fixture.componentRef.setInput('value', 99);
    fixture.detectChanges();
    await fixture.whenStable();
    const host: HTMLElement = fixture.nativeElement;
    const current = host.querySelector('.current');
    fixture.componentRef.setInput('value', '99+');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(host.querySelector('.current')).toBe(current);
    expect(current?.textContent).toBe('99+');
  });

  it('retargets both rendered faces from their current visual state and cancels on disposal', async () => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const matches = vi.spyOn(media, 'matches', 'get').mockReturnValue(false);
    const matchMedia = vi.spyOn(window, 'matchMedia').mockReturnValue(media);
    try {
      const fixture = TestBed.createComponent(FlipCountComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.componentRef.setInput('value', 1);
      fixture.detectChanges();
      await fixture.whenStable();
      const host: HTMLElement = fixture.nativeElement;
      const current = host.querySelector<HTMLElement>('.current')!;
      const previous = host.querySelector<HTMLElement>('.previous')!;
      const oldAnimations = host.getAnimations({ subtree: true });
      expect(oldAnimations).toHaveLength(2);
      for (const animation of oldAnimations) animation.currentTime = 80;
      const currentTransform = getComputedStyle(current).transform;
      const previousTransform = getComputedStyle(previous).transform;
      fixture.componentRef.setInput('value', 2);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(
        oldAnimations.every((animation) => animation.playState === 'idle'),
      ).toBe(true);
      const currentEffect = current.getAnimations()[0]?.effect;
      const previousEffect = previous.getAnimations()[0]?.effect;
      expect(currentEffect).toBeInstanceOf(KeyframeEffect);
      if (
        currentEffect instanceof KeyframeEffect &&
        previousEffect instanceof KeyframeEffect
      ) {
        expect(currentEffect.getKeyframes()[0]['transform']).toBe(
          currentTransform,
        );
        expect(previousEffect.getKeyframes()[0]['transform']).toBe(
          previousTransform,
        );
      }
      expect(current.textContent).toBe('2');
      const animations = host.getAnimations({ subtree: true });
      matches.mockReturnValue(true);
      media.dispatchEvent(new Event('change'));
      expect(
        animations.every((animation) => animation.playState === 'idle'),
      ).toBe(true);
      fixture.componentRef.setInput('value', 3);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(host.getAnimations({ subtree: true })).toHaveLength(0);
      fixture.destroy();
    } finally {
      matchMedia.mockRestore();
      matches.mockRestore();
    }
  });
});
