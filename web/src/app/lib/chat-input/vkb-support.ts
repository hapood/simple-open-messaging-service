/**
 * Feature detection + typed accessor for the VirtualKeyboard API (the Telegram/WhatsApp-style
 * emoji-keyboard swap).
 *
 * The swap calls `navigator.virtualKeyboard.hide()` / `show()`, gated by `virtualkeyboardpolicy="manual"`
 * on the Tiptap editable. That API is Chromium-only — present on Chrome / Edge / Samsung Internet on
 * Android (the PWA's mobile target) and absent on iOS Safari and Firefox Android, which fall back to
 * the legacy popup-above-the-bar.
 *
 * The API is not yet in TypeScript's built-in lib.dom.d.ts, so {@link VirtualKeyboardLike} is a minimal
 * structural type. {@link getVirtualKeyboard} returns it (or null) so callers stay type-safe with no `any`
 * and no casts at use-sites. SSR-safe (`typeof navigator` guarded).
 */

export interface VirtualKeyboardLike {
  show(): void;
  hide(): void;
  overlaysContent: boolean;
  readonly boundingRect: DOMRect;
  addEventListener(type: 'geometrychange', listener: (ev: Event) => void): void;
  removeEventListener(type: 'geometrychange', listener: (ev: Event) => void): void;
}

/** The navigator.virtualKeyboard instance, or null when the API is unavailable (iOS Safari, Firefox, SSR). */
export function getVirtualKeyboard(): VirtualKeyboardLike | null {
  if (typeof navigator === 'undefined' || !('virtualKeyboard' in navigator)) return null;
  return (navigator as unknown as { virtualKeyboard: VirtualKeyboardLike }).virtualKeyboard;
}

/** Show the system IME while preserving the focused editor. Android Tauri uses the native bridge because
 * WebView VirtualKeyboard API behavior varies by provider/OEM; Chromium browser/PWA uses the web API. */
export function showIme(): boolean {
  const nativeShow = typeof window !== 'undefined' ? window.SomsShell?.showIme : undefined;
  if (nativeShow) {
    nativeShow();
    return true;
  }
  const keyboard = getVirtualKeyboard();
  if (!keyboard) return false;
  keyboard.show();
  return true;
}

/** Hide the system IME without blurring the editor. Returns false only when neither native nor web control
 * is available, allowing callers to choose an explicit legacy fallback. */
export function hideIme(): boolean {
  const nativeHide = typeof window !== 'undefined' ? window.SomsShell?.hideIme : undefined;
  if (nativeHide) {
    nativeHide();
    return true;
  }
  const keyboard = getVirtualKeyboard();
  if (!keyboard) return false;
  keyboard.hide();
  return true;
}

/**
 * Whether the emoji-keyboard swap is available: a touch (soft-keyboard) device AND the VirtualKeyboard API
 * present. Pure (reads only its arg + navigator) so it is trivially unit-testable without a component harness.
 * The single arbiter of the swap rule — called only by {@link InputDeviceService} (which exposes it as the
 * `emojiSwapSupported` / `inputClass` signals); consumers read those signals rather than calling this.
 *
 * @param hasPhysicalKeyboard true on a physical-keyboard (fine-pointer) device — the swap is touch-only.
 */
export function vkbSwapSupported(hasPhysicalKeyboard: boolean): boolean {
  if (hasPhysicalKeyboard) return false;
  return getVirtualKeyboard() !== null;
}
