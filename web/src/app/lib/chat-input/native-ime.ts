/** Show the Android system IME through the native shell while preserving the focused editor. */
export function showIme(): boolean {
  const nativeShow = typeof window !== 'undefined' ? window.SomsShell?.showIme : undefined;
  if (!nativeShow) return false;
  nativeShow();
  return true;
}

/** Hide the Android system IME through the native shell without blurring the editor. */
export function hideIme(): boolean {
  const nativeHide = typeof window !== 'undefined' ? window.SomsShell?.hideIme : undefined;
  if (!nativeHide) return false;
  nativeHide();
  return true;
}
