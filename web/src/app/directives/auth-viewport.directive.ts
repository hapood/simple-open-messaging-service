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

/**
 * Publishes the soft-keyboard occlusion on auth/setup page hosts.
 *
 * Android's edge-to-edge WebView keeps `100dvh` unchanged while the IME is open, so viewport CSS alone
 * cannot keep focused fields visible. Auth surfaces consume this variable to size their scrollable,
 * visible area above the keyboard. Browser/iOS values come from visualViewport through the same service.
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
      this.keyboard.inset();
      this.keyboard.open();
      this.scheduleFocusedLift();
    });
    this.destroyRef.onDestroy(() => {
      if (this.measureFrame !== null) cancelAnimationFrame(this.measureFrame);
    });
  }

  @HostBinding('style.--auth-keyboard-inset')
  get keyboardInset(): string {
    return `${this.ownsFocus() ? this.keyboard.inset() : 0}px`;
  }

  @HostBinding('class.auth-keyboard-open')
  get keyboardOpen(): boolean {
    return this.ownsFocus() && this.keyboard.open();
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
    const keyboardTop = document.documentElement.clientHeight - this.keyboard.inset();

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
    const currentGap = keyboardTop - unshiftedInputBottom;
    const targetGap = 24;
    const requestedLift = Math.max(0, targetGap - currentGap);

    // Preserve at least the pane's 20px keyboard-open top padding. The 80px product cap keeps the motion
    // subtle; the dynamic cap additionally prevents the card from being transformed above the viewport.
    const hostTop = this.host.getBoundingClientRect().top;
    const unshiftedCardTop = liftTarget
      ? liftTarget.getBoundingClientRect().top + renderedLift
      : hostTop;
    const topSafeLift = Math.max(0, unshiftedCardTop - hostTop - 20);
    this.focusedLift.set(Math.min(80, topSafeLift, requestedLift));
  }
}
