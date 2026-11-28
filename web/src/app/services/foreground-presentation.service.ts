import { DestroyRef, Injectable, inject, signal } from '@angular/core';

/** Shared UI focus observation; not an authority for read receipts or native work. */
@Injectable({ providedIn: 'root' })
export class ForegroundPresentation {
  private readonly value = signal(false);
  readonly focused = this.value.asReadonly();

  constructor() {
    if (typeof document === 'undefined') return;
    const update = () =>
      this.value.set(
        document.visibilityState === 'visible' && document.hasFocus(),
      );
    const blur = () => this.value.set(false);
    update();
    window.addEventListener('focus', update);
    window.addEventListener('blur', blur);
    document.addEventListener('visibilitychange', update);
    inject(DestroyRef).onDestroy(() => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', blur);
      document.removeEventListener('visibilitychange', update);
    });
  }
}
