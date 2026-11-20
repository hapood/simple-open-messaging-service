import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  afterRenderEffect,
  inject,
  input,
  viewChild,
  ElementRef,
} from '@angular/core';
import { FlipCountComponent } from './flip-count.component';

/** Independent count slot. Zero removes content immediately; only its width lingers. */
@Component({
  selector: 'app-task-count-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FlipCountComponent],
  host: { '[class.separated]': 'separated()' },
  template: `
    <span #slot class="slot">
      <span #body class="body">
        @if (count() > 0) {
          <ng-content />
          <app-flip-count [value]="count()" [animate]="animate()" />
        }
      </span>
    </span>
  `,
  styles: `
    :host { display: block; height: 20px; line-height: 20px; }
    .slot { display: block; height: 20px; line-height: 20px; overflow: hidden; }
    .body {
      display: flex; align-items: center; gap: 4px;
      width: max-content; height: 20px; line-height: 20px;
    }
    :host(.separated) .body { padding-left: 14px; }
  `,
})
export class TaskCountGroupComponent {
  readonly count = input(0);
  readonly animate = input(true);
  readonly separated = input(false);
  private readonly slot = viewChild.required<ElementRef<HTMLElement>>('slot');
  private readonly body = viewChild.required<ElementRef<HTMLElement>>('body');
  private widthAnimation?: Animation;
  private fadeAnimation?: Animation;
  private targetWidth: number | undefined;
  private previousCount = 0;

  constructor() {
    const preference = matchMedia('(prefers-reduced-motion: reduce)');
    const cancel = () => {
      this.widthAnimation?.cancel();
      this.fadeAnimation?.cancel();
    };
    preference.addEventListener('change', cancel);
    inject(DestroyRef).onDestroy(() => {
      cancel();
      preference.removeEventListener('change', cancel);
    });
    afterRenderEffect(() => {
      const count = this.count();
      this.separated();
      const slot = this.slot().nativeElement;
      const body = this.body().nativeElement;
      const width = count > 0 ? body.offsetWidth : 0;
      const from = parseFloat(getComputedStyle(slot).width) || 0;
      const entering = this.previousCount === 0 && count > 0;
      const initialized = this.targetWidth !== undefined;
      this.previousCount = count;
      if (width === this.targetWidth) return;
      cancel();
      this.targetWidth = width;
      slot.style.width = `${width}px`;
      if (!initialized || preference.matches) return;
      this.widthAnimation = slot.animate(
        [{ width: `${from}px` }, { width: `${width}px` }],
        { duration: 180, easing: 'ease-out' },
      );
      if (entering) {
        this.fadeAnimation = body.animate([{ opacity: 0 }, { opacity: 1 }], {
          duration: 180,
          easing: 'ease-out',
        });
      }
    });
  }
}
