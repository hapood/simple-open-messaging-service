import { computed, inject, Injectable } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { BreakpointObserver } from '@angular/cdk/layout';
import { map } from 'rxjs';

// Fine pointer + hover, with NO width clause: a desktop-class INPUT device (mouse/trackpad ⇒ a physical
// keyboard is present; no soft keyboard). Width-independent on purpose — a small laptop window or a narrow
// Tauri desktop shell still has a physical keyboard, so Enter-to-send and soft-keyboard tracking must
// NOT flip just because the viewport shrank below the 3-pane width. This is the INPUT axis; for layout
// (pane count) see {@link LayoutService}.
const FINE_POINTER_QUERY = '(pointer: fine) and (hover: hover)';

/** The two input-device classes the composer branches on. Orthogonal to layout width.
 *  - `physical`:    primary pointer is a mouse/trackpad ⇒ a physical keyboard is attached. Enter sends;
 *                   keyboard-offset tracking is a no-op.
 *  - `soft`:        a touch device using a system soft keyboard. Enter inserts a newline. */
export type InputClass = 'physical' | 'soft';

/**
 * Single source of truth for the INPUT axis (what kind of keyboard the user types with), deliberately
 * decoupled from {@link LayoutService} (the LAYOUT axis — how many panes fit, pure width).
 *
 * `hasFinePointer` lives here (not on LayoutService) so width decisions and input-modality decisions cannot
 * accidentally recouple. The class is derived from one media query; the derived signals express INTENT
 * so consumers never re-derive the rules:
 *
 * - {@link hasPhysicalKeyboard}: short-circuit for anything that assumes "no soft keyboard is possible"
 *   (the kbd-offset tracker).
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
    return this.finePointer() ? 'physical' : 'soft';
  });

  /** True when the primary input is a mouse/trackpad (a physical keyboard is attached). Width-independent. */
  readonly hasPhysicalKeyboard = computed(() => this.inputClass() === 'physical');
  /** The Enter-key convention's single switch point (device-dependent; redirect here for a user setting). */
  readonly enterToSend = computed(() => this.inputClass() === 'physical');
}
