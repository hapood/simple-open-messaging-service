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
import { KeyboardInsetService, uncompensatedKbdInset } from '../services/keyboard-inset.service';

/** Native-only focused-field lift. Browsers own their keyboard focus reveal and viewport panning. */
export function authFocusedLift(inputBottom: number, keyboardTop: number): number {
  return Math.max(0, Math.ceil(inputBottom + 24 - keyboardTop));
}

/**
 * Keeps native auth/setup fields above the IME without resizing the full-screen layout.
 * Browser hosts do not apply keyboard geometry: the browser owns focus reveal.
 */
@Directive({
  selector: '[appAuthViewport]',
  standalone: true,
})
export class AuthViewportDirective {
  private readonly keyboard = inject(KeyboardInsetService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly destroyRef = inject(DestroyRef);
  private readonly focusedLift = signal(0);
  private readonly ownsFocus = signal(false);
  private measureFrame: number | null = null;

  constructor() {
    // Re-measure at the settled animation endpoint. Focus changes are handled separately below; reading
    // both signals here also covers a keyboard opening while an autofocused field already owns focus.
    effect(() => {
      if (!this.keyboard.available) return;
      this.keyboard.inset();
      this.keyboard.open();
      this.keyboard.viewportReduction();
      this.scheduleFocusedLift();
    });
    this.destroyRef.onDestroy(() => {
      if (this.measureFrame !== null) cancelAnimationFrame(this.measureFrame);
    });
  }

  @HostBinding('class.auth-native-viewport')
  get nativeViewport(): boolean {
    return this.keyboard.available;
  }

  /** Native-only styling hook. Browser auth pages keep their existing soft-keyboard layout; the subtle
   * centered lift is an Android shell treatment backed by authoritative WindowInsets geometry. */
  @HostBinding('class.auth-native-keyboard-open')
  get nativeKeyboardOpen(): boolean {
    return this.ownsFocus() && this.keyboard.available && this.keyboard.open();
  }

  @HostBinding('style.--auth-focused-lift')
  get focusedLiftPx(): string {
    return `${this.focusedLift()}px`;
  }

  @HostListener('focusin')
  @HostListener('focusout')
  onFocusChange(): void {
    // focusout fires before the next control receives focus; measuring on the next frame observes the
    // final activeElement and avoids a zero-lift frame when moving from account to password.
    this.scheduleFocusedLift();
  }

  private scheduleFocusedLift(): void {
    if (!this.keyboard.available) return;
    if (this.measureFrame !== null) cancelAnimationFrame(this.measureFrame);
    this.measureFrame = requestAnimationFrame(() => {
      this.measureFrame = null;
      this.measureFocusedLift();
    });
  }

  private measureFocusedLift(): void {
    const active = document.activeElement;
    const ownsFocus = active instanceof HTMLElement && this.host.contains(active);
    this.ownsFocus.set(ownsFocus);

    if (!ownsFocus || !this.keyboard.available || !this.keyboard.open()) {
      this.focusedLift.set(0);
      return;
    }

    if (!(active instanceof HTMLInputElement)) {
      this.focusedLift.set(0);
      return;
    }

    // Native inset is the authoritative input. Do not infer the keyboard edge from the host's CSS height:
    // that would make the geometry calculation depend on style/layout having already settled.
    const keyboardTop = document.documentElement.clientHeight - uncompensatedKbdInset(
      this.keyboard.inset(), this.keyboard.viewportReduction(),
    );

    // A rapid account→password switch can happen while the previous CSS transition is between frames.
    // Recover the input's untransformed position from the ACTUAL rendered matrix, rather than adding the
    // signal's destination value (which may not have been reached yet).
    const liftTarget = active.closest<HTMLElement>('.login-card, .cfg-shell');
    const renderedTransform = liftTarget ? getComputedStyle(liftTarget).transform : 'none';
    const renderedTranslateY = renderedTransform === 'none'
      ? 0
      : new DOMMatrixReadOnly(renderedTransform).m42;
    const renderedLift = Math.max(0, -renderedTranslateY);
    const unshiftedInputBottom = active.getBoundingClientRect().bottom + renderedLift;
    // Do not cap the lift: on a short screen that would leave the focused field behind the IME.
    // Changing focus repositions the card for that field, without changing its full-screen layout.
    this.focusedLift.set(authFocusedLift(unshiftedInputBottom, keyboardTop));
  }
}
