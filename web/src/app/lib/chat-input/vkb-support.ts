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

/**
 * Whether the emoji-keyboard swap is available: mobile layout AND the VirtualKeyboard API present.
 * Pure (reads only its arg + navigator) so it is trivially unit-testable without a component harness.
 *
 * @param isDesktop true on the desktop layout — the swap is mobile-only (no soft keyboard desktop-side).
 */
export function vkbSwapSupported(isDesktop: boolean): boolean {
  if (isDesktop) return false;
  return getVirtualKeyboard() !== null;
}
