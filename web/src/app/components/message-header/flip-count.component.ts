import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  inject,
  input,
  viewChild,
} from '@angular/core';

/** One visual value transition; superseding updates cancel rather than queue animations. */
@Component({
  selector: 'app-flip-count',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<span #previous class="previous" aria-hidden="true"></span
    ><span #current class="current">{{ value() }}</span>`,
  styles: `
    :host {
      position: relative;
      display: inline-grid;
      height: 20px;
      line-height: 20px;
      perspective: 160px;
      font-variant-numeric: tabular-nums;
    }
    span {
      grid-area: 1 / 1;
      height: 20px;
      line-height: 20px;
      backface-visibility: hidden;
      transform-origin: center;
    }
    .previous {
      position: absolute;
      inset: 0;
      visibility: hidden;
    }
  `,
})
export class FlipCountComponent {
  readonly value = input(0);
  readonly animate = input(true);
  private readonly previous =
    viewChild.required<ElementRef<HTMLElement>>('previous');
  private readonly current =
    viewChild.required<ElementRef<HTMLElement>>('current');
  private lastValue: number | undefined;
  private animations: Animation[] = [];

  constructor() {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const onPreferenceChange = (): void => {
      if (preference.matches) this.cancelAnimations();
    };
    preference.addEventListener('change', onPreferenceChange);
    inject(DestroyRef).onDestroy(() => {
      preference.removeEventListener('change', onPreferenceChange);
      this.cancelAnimations();
    });
    afterRenderEffect(() => {
      const value = this.value();
      const enabled = this.animate();
      const previous = this.previous().nativeElement;
      const current = this.current().nativeElement;
      this.cancelAnimations();
      const old = this.lastValue;
      this.lastValue = value;
      if (old === undefined || old === value || !enabled || preference.matches)
        return;
      previous.textContent = String(old);
      this.animations = [
        previous.animate(
          [
            { visibility: 'visible', transform: 'rotateX(0)', opacity: 1 },
            { visibility: 'visible', transform: 'rotateX(90deg)', opacity: 0 },
          ],
          { duration: 220, easing: 'ease-in' },
        ),
        current.animate(
          [
            { transform: 'rotateX(-90deg)', opacity: 0 },
            { transform: 'rotateX(0)', opacity: 1 },
          ],
          { duration: 220, easing: 'ease-out' },
        ),
      ];
    });
  }

  private cancelAnimations(): void {
    for (const animation of this.animations) animation.cancel();
    this.animations = [];
  }
}
