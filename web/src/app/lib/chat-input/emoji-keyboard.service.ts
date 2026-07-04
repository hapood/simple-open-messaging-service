import { computed, inject, Injectable, signal } from '@angular/core';
import { LayoutService } from '../../services/layout.service';
import { getVirtualKeyboard, vkbSwapSupported } from './vkb-support';

/**
 * State machine for the Telegram/WhatsApp-style emoji-keyboard swap (Android Chromium only).
 *
 * The swap dismisses the native soft keyboard (`navigator.virtualKeyboard.hide()`) and renders a
 * full-width emoji panel in its place; an ABC chip re-focuses the editor, whose focus→show handler
 * (see chat-editor.component.ts) brings the native keyboard back. Because the editor never blurs, the
 * caret survives and emojis insert at the cursor.
 *
 * Root-scoped so the host (which binds the input-bar lift: `margin-bottom = open ? 0 : offset`) and
 * the ChatInputComponent (which renders the panel) share one source of truth. No global side-effects,
 * so — unlike ThemeService — it need not be eagerly constructed; it is lazily injected by its consumers.
 */
@Injectable({ providedIn: 'root' })
export class EmojiKeyboardService {
  private readonly layout = inject(LayoutService);

  /** Swap available: mobile layout AND the VirtualKeyboard API present (Android Chromium). iOS Safari,
   *  Firefox Android, and desktop fall back to the legacy popup and this service stays inert. */
  readonly supported = computed(() => vkbSwapSupported(this.layout.isDesktop()));

  /** Whether the swap panel is currently open. */
  readonly open = signal(false);

  /** The panel height captured at toggle time, so the panel occupies the region the keyboard vacated
   *  and the message-list viewport need not change size across the swap (kernel invariant). */
  readonly frozenHeight = signal(0);

  /** Toggle the swap. `currentHeight` is the keyboard occlusion height to freeze as the panel height,
   *  captured BEFORE hide() (after hide the layout grows and the height is no longer observable). */
  toggle(currentHeight: number): void {
    if (this.open()) { this.close(); return; }
    this.frozenHeight.set(currentHeight);
    this.open.set(true);
    getVirtualKeyboard()?.hide();
  }

  /** Close the panel. The native keyboard is NOT reshown here — it returns when the editor regains
   *  focus (the ABC chip calls editor.focus(), whose focus→show handler calls show()). Centralizing
   *  show() here would race the focus event; tying it to focus is the reliable path. */
  close(): void {
    if (!this.open()) return;
    this.open.set(false);
  }
}
