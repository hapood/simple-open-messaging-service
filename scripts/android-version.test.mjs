import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateAndroidVersion } from './android-version.mjs';

const config = (version = '0.1.0-alpha.2', versionCode = 1001) => ({
  version,
  bundle: { android: { versionCode, autoIncrementVersionCode: false } },
});
const legacy = { version: '0.1.0-alpha.1' };

test('alpha.2 advances beyond the legacy semver-derived code', () => {
  assert.doesNotThrow(() => validateAndroidVersion(config(), legacy));
  assert.throws(
    () => validateAndroidVersion(config(undefined, 1000), legacy),
    /requires Android versionCode > 1000/,
  );
});

test('requires an explicit valid Android code', () => {
  for (const code of [undefined, null, 0, -1, 1.5, '1001', 2_100_000_001]) {
    const candidate = config();
    candidate.bundle.android.versionCode = code;
    assert.throws(() => validateAndroidVersion(candidate), /explicit integer/);
  }
  assert.doesNotThrow(() =>
    validateAndroidVersion(config(undefined, 2_100_000_000)),
  );
});

test('disallows build-local auto-increment, including an unspecified policy', () => {
  for (const value of [true, undefined]) {
    const candidate = config();
    candidate.bundle.android.autoIncrementVersionCode = value;
    assert.throws(() => validateAndroidVersion(candidate), /must be false/);
  }
});

test('repeated and per-ABI builds retain the same code', () => {
  assert.doesNotThrow(() => validateAndroidVersion(config(), config()));
  assert.throws(
    () => validateAndroidVersion(config(undefined, 1002), config()),
    /same release/,
  );
});

test('later prerelease and stable versions must both advance the code', () => {
  for (const version of ['0.1.0-alpha.3', '0.1.0', '0.2.0-alpha.0']) {
    assert.throws(
      () => validateAndroidVersion(config(version, 1001), config()),
      /requires Android versionCode/,
    );
    assert.doesNotThrow(() =>
      validateAndroidVersion(config(version, 1002), config()),
    );
  }
});

test('fails closed when the legacy code cannot be resolved', () => {
  assert.throws(
    () => validateAndroidVersion(config(), { version: 'invalid' }),
    /Cannot determine/,
  );
});
