import { Directive, HostBinding, inject } from '@angular/core';
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

  @HostBinding('style.--auth-keyboard-inset')
  get keyboardInset(): string {
    return `${this.keyboard.inset()}px`;
  }

  @HostBinding('class.auth-keyboard-open')
  get keyboardOpen(): boolean {
    return this.keyboard.open();
  }
}
