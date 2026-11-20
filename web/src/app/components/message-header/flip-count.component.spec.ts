import { TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { FlipCountComponent } from './flip-count.component';

describe('FlipCountComponent', () => {
  it('renders the latest value without remounting the counter', async () => {
    const fixture = TestBed.createComponent(FlipCountComponent);
    fixture.componentRef.setInput('animate', false);
    fixture.componentRef.setInput('value', 9);
    fixture.detectChanges();
    await fixture.whenStable();
    const current = fixture.nativeElement.querySelector('.current');
    fixture.componentRef.setInput('value', 10);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.nativeElement.querySelector('.current')).toBe(current);
    expect(current.textContent).toBe('10');
  });

  it('cancels prior animations on rapid updates and disposal', async () => {
    const animations: { cancel: ReturnType<typeof vi.fn> }[] = [];
    const animate = vi
      .spyOn(HTMLElement.prototype, 'animate')
      .mockImplementation(() => {
        const animation = { cancel: vi.fn() };
        animations.push(animation);
        return animation as unknown as Animation;
      });
    const preference = new EventTarget() as EventTarget & { matches: boolean };
    preference.matches = false;
    const removeListener = vi.spyOn(preference, 'removeEventListener');
    const media = vi
      .spyOn(window, 'matchMedia')
      .mockReturnValue(preference as MediaQueryList);
    try {
      const fixture = TestBed.createComponent(FlipCountComponent);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.componentRef.setInput('value', 1);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(animations).toHaveLength(2);
      fixture.componentRef.setInput('value', 2);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(animations[0].cancel).toHaveBeenCalledOnce();
      expect(animations).toHaveLength(4);
      preference.matches = true;
      preference.dispatchEvent(new Event('change'));
      expect(animations[3].cancel).toHaveBeenCalledOnce();
      fixture.componentRef.setInput('value', 3);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(animations).toHaveLength(4);
      expect(fixture.nativeElement.querySelector('.current').textContent).toBe(
        '3',
      );
      fixture.destroy();
      expect(removeListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function),
      );
    } finally {
      animate.mockRestore();
      media.mockRestore();
    }
  });
});
