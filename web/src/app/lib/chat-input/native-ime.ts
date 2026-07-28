/** Show the Android system IME through the native shell while preserving the focused editor. */
export function showIme(): boolean {
  if (typeof window === 'undefined' || !window.SomsShell?.showIme) return false;
  // Android @JavascriptInterface methods must be invoked through the injected object. Extracting the
  // function first loses that receiver on Huawei WebView and throws "non-injected object".
  window.SomsShell.showIme();
  return true;
}

/** Hide the Android system IME through the native shell without blurring the editor. */
export function hideIme(): boolean {
  if (typeof window === 'undefined' || !window.SomsShell?.hideIme) return false;
  window.SomsShell.hideIme();
  return true;
}
