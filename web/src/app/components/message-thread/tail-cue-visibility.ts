/** Require full visibility to enter; tolerate two pixels while leaving to avoid edge chatter. */
export function isTailCueVisible(
  top: number,
  bottom: number,
  visibleTop: number,
  visibleBottom: number,
  wasVisible: boolean,
): boolean {
  const tolerance = wasVisible ? 2 : 0;
  return bottom > top && top >= visibleTop - tolerance && bottom <= visibleBottom + tolerance;
}
