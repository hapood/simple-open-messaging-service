/** Android upgrade ordering is independent of the display version and build count. */
export function validateAndroidVersion(config, previous) {
  const android = config.bundle?.android;
  const code = android?.versionCode;
  if (!Number.isInteger(code) || code < 1 || code > 2_100_000_000) {
    throw new Error(
      'bundle.android.versionCode must be an explicit integer from 1 to 2100000000',
    );
  }
  if (android.autoIncrementVersionCode !== false) {
    throw new Error(
      'bundle.android.autoIncrementVersionCode must be false for reproducible per-ABI builds',
    );
  }
  if (!previous) return;

  // Older releases used Tauri's default, which ignores prerelease identifiers.
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-|$)/.exec(previous.version);
  const previousCode =
    previous.bundle?.android?.versionCode ??
    (match
      ? Number(match[1]) * 1_000_000 +
        Number(match[2]) * 1_000 +
        Number(match[3])
      : NaN);
  if (!Number.isInteger(previousCode) || previousCode < 1) {
    throw new Error('Cannot determine the previous Android versionCode');
  }
  if (config.version === previous.version) {
    if (code !== previousCode) {
      throw new Error(
        'The same release version must retain its Android versionCode',
      );
    }
  } else if (code <= previousCode) {
    throw new Error(
      `A new release requires Android versionCode > ${previousCode} (received ${code})`,
    );
  }
}
