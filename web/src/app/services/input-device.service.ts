import { computed, inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { BreakpointObserver } from '@angular/cdk/layout';
import { map } from 'rxjs';
import { vkbSwapSupported } from '../lib/chat-input/vkb-support';

// Fine pointer + hover, with NO width clause: a desktop-class INPUT device (mouse/trackpad ⇒ a physical
// keyboard is present; no soft keyboard). Width-independent on purpose — a small laptop window or a narrow
// Tauri desktop shell still has a physical keyboard, so Enter-to-send and the absence of the VKB swap must
// NOT flip just because the viewport shrank below the 3-pane width. This is the INPUT axis; for layout
// (pane count) see {@link LayoutService}.
const FINE_POINTER_QUERY = '(pointer: fine) and (hover: hover)';

/** The three input-device classes the composer branches on. Orthogonal to layout width.
 *  - `physical`:    primary pointer is a mouse/trackpad ⇒ a physical keyboard is attached. Enter sends;
 *                   the emoji swap is inert (popup fallback); keyboard-offset tracking is a no-op.
 *  - `soft-vkb`:    a touch (soft-keyboard) device WITH the VirtualKeyboard API (Android Chromium). Enter
 *                   inserts a newline; the Telegram-style emoji swap replaces the keyboard region.
 *  - `soft-legacy`: a touch device WITHOUT the VirtualKeyboard API (iOS Safari, Firefox Android, old
 *                   Android). Enter inserts a newline; the emoji board falls back to the popup. */
export type InputClass = 'physical' | 'soft-vkb' | 'soft-legacy';

/**
 * Single source of truth for the INPUT axis (what kind of keyboard the user types with), deliberately
 * decoupled from {@link LayoutService} (the LAYOUT axis — how many panes fit, pure width).
 *
 * `hasFinePointer` lives here (not on LayoutService) so width decisions and input-modality decisions cannot
 * accidentally recouple. The class is derived from one media query plus the swap-availability rule in
 * {@link vkbSwapSupported} (the single arbiter of "is the Telegram swap available"); the three derived
 * signals express INTENT so consumers never re-derive the rules:
 *
 * - {@link hasPhysicalKeyboard}: short-circuit for anything that assumes "no soft keyboard is possible"
 *   (the kbd-offset tracker; the popup-vs-swap gate's negative branch).
 * - {@link emojiSwapSupported}: the Telegram-style swap is available (touch + VKB API). Sole gate for the
 *   swap-vs-popup branching; supersedes ad-hoc `vkbSwapSupported(hasFinePointer)` calls at consumer sites.
 * - {@link enterToSend}: the Enter-key convention's single switch point. Today identical to
 *   `hasPhysicalKeyboard` (device-dependent: physical ⇒ send, soft ⇒ newline), but kept separate so a future
 *   per-user "Enter sends / inserts newline" setting can redirect ONLY this signal without touching device
 *   classification.
 *
 * `providedIn: 'root'` and lazily injected by its consumers (the chat editor, the emoji service, the
 * kbd-offset directive) — no eager initialization needed.
 */
@Injectable({ providedIn: 'root' })
export class InputDeviceService {
  private readonly bpObserver = inject(BreakpointObserver);

  private readonly finePointer = toSignal(
    this.bpObserver.observe(FINE_POINTER_QUERY).pipe(map((result) => result.matches)),
    { initialValue: this.bpObserver.isMatched(FINE_POINTER_QUERY) },
  );

  readonly inputClass = computed<InputClass>(() => {
    const fp = this.finePointer();
    if (fp) return 'physical';
    // fp is false here ⇒ vkbSwapSupported reduces to "is the VirtualKeyboard API present". Keeping the rule
    // in vkbSwapSupported (one place) instead of re-checking navigator.virtualKeyboard at this call site.
    return vkbSwapSupported(fp) ? 'soft-vkb' : 'soft-legacy';
  });

  /** True when the primary input is a mouse/trackpad (a physical keyboard is attached). Width-independent. */
  readonly hasPhysicalKeyboard = computed(() => this.inputClass() === 'physical');
  /** True when the Telegram-style emoji swap is available (touch + VirtualKeyboard API). */
  readonly emojiSwapSupported = computed(() => this.inputClass() === 'soft-vkb');
  /** The Enter-key convention's single switch point (device-dependent; redirect here for a user setting). */
  readonly enterToSend = computed(() => this.inputClass() === 'physical');
}
