import {
  DestroyRef,
  Directive,
  effect,
  ElementRef,
  HostBinding,
  HostListener,
  inject,
  signal,
} from '@angular/core';
import { KeyboardInsetService } from '../services/keyboard-inset.service';

export function focusedInputScrollDelta(
  inputTop: number,
  inputBottom: number,
  visibleTop: number,
  keyboardTop: number,
  gap = 24,
): number {
  const bottomOverflow = inputBottom - (keyboardTop - gap);
  if (bottomOverflow > 0) return Math.ceil(bottomOverflow);
  const topOverflow = inputTop - (visibleTop + gap);
  return topOverflow < 0 ? Math.floor(topOverflow) : 0;
}

/** Keeps the focused form control visible inside a scroll panel while the soft keyboard is open. */
@Directive({ selector: '[appFocusedInputReveal]' })
export class FocusedInputRevealDirective {
  private readonly host =
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly keyboard = inject(KeyboardInsetService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly ownsFocus = signal(false);
  private frame: number | null = null;

  constructor() {
    effect(() => {
      this.keyboard.inset();
      this.keyboard.open();
      this.scheduleReveal();
    });
    this.destroyRef.onDestroy(() => {
      if (this.frame !== null) cancelAnimationFrame(this.frame);
    });
  }

  @HostBinding('style.--focused-input-keyboard-inset')
  get keyboardInset(): string {
    return `${this.ownsFocus() && this.keyboard.open() ? this.keyboard.inset() : 0}px`;
  }

  @HostListener('focusin')
  @HostListener('focusout')
  onFocusChange(): void {
    this.scheduleReveal();
  }

  private scheduleReveal(): void {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      this.revealFocusedControl();
    });
  }

  private revealFocusedControl(): void {
    const active = document.activeElement;
    const ownsFocus =
      active instanceof HTMLElement && this.host.contains(active);
    this.ownsFocus.set(ownsFocus);
    if (!ownsFocus || !this.keyboard.open()) return;
    if (
      !(
        active instanceof HTMLInputElement ||
        active instanceof HTMLTextAreaElement
      )
    )
      return;

    const hostRect = this.host.getBoundingClientRect();
    const inputRect = active.getBoundingClientRect();
    const keyboardTop =
      document.documentElement.clientHeight - this.keyboard.inset();
    const delta = focusedInputScrollDelta(
      inputRect.top,
      inputRect.bottom,
      hostRect.top,
      keyboardTop,
    );
    if (delta !== 0) this.host.scrollBy({ top: delta, behavior: 'auto' });
  }
}
