import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
function plan(target, ...args) {
  return execFileSync('make', ['-n', '-C', 'src-tauri', target, ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

for (const target of ['apk-debug', 'linux', 'macos', 'dev']) {
  test(`${target} uses the lockfile-provided Tauri CLI`, () => {
    const output = plan(target, 'ABI=aarch64', 'WEB_BUILD=0');
    assert.match(output, /node "[^"\n]+\/web\/node_modules\/@tauri-apps\/cli\/tauri\.js"/);
    assert.doesNotMatch(output, /cargo tauri (?:build|android|dev)/);
  });
}

test('Android checks only requested ABIs and verifies reused frontend output', () => {
  const output = plan('apk-debug', 'ABI=aarch64', 'WEB_BUILD=0');
  assert.match(output, /for abi in aarch64; do/);
  assert.match(output, /run verify:native/);
  assert.doesNotMatch(output, /run build:native/);
  assert.match(plan('apk-debug'), /for abi in aarch64 armv7 i686 x86_64; do/);
  assert.match(plan('apk-debug', 'ABI=all'), /for abi in aarch64 armv7 i686 x86_64; do/);
  assert.match(plan('apk-debug', 'ABI=all'), /run build:native/);
  assert.match(plan('apk-debug', 'ABI=all', 'MULTI_ABIS=aarch64 x86_64'), /for abi in aarch64 x86_64; do/);
});
