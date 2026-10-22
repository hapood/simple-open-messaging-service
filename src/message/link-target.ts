/** Validate the wire link target's syntax without imposing a scheme policy. */
export function isAbsoluteLinkTarget(value: unknown): value is string {
  if (
    typeof value !== 'string' ||
    Array.from(value).length > 2048 ||
    !/^[A-Za-z][A-Za-z0-9+.-]*:[^\s\u0000-\u001f\u007f-\u009f]+$/.test(value)
  ) {
    return false;
  }
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
