import { DOCUMENT } from '@angular/common';
import { DestroyRef, effect, inject, Injectable } from '@angular/core';
import {
  KeyboardInsetService,
  uncompensatedKbdInset,
} from './keyboard-inset.service';
import { NativeComposerService } from './native-composer.service';

/** Owns global Snackbar positioning independently of the feedback producer and current route. */
@Injectable({ providedIn: 'root' })
export class SnackbarGeometryService {
  private readonly keyboard = inject(KeyboardInsetService);
  private readonly composer = inject(NativeComposerService);
  private readonly document = inject(DOCUMENT);

  constructor() {
    // Browser overlays already follow the visible viewport; only Android's edge-to-edge WebView
    // needs explicit IME compensation. Keep the browser's CSS composer/safe-area fallback intact.
    if (!this.keyboard.available) return;
    const style = this.document.documentElement.style;
    effect(() => {
      const active = this.composer.active();
      // Native geometry includes either the system IME or its emoji replacement. Choose one source,
      // never add global IME height to a composer-owned keyboard surface.
      const keyboardHeight = active
        ? this.composer.keyboardHeight()
        : this.keyboard.inset();
      const occupied =
        (active ? this.composer.composerHeight() : 0) +
        uncompensatedKbdInset(keyboardHeight, this.keyboard.viewportReduction());
      style.setProperty(
        '--soms-snackbar-bottom-offset',
        `calc(${occupied}px + var(--soms-safe-bottom, 0px))`,
      );
    });
    inject(DestroyRef).onDestroy(() => {
      style.removeProperty('--soms-snackbar-bottom-offset');
    });
  }
}
