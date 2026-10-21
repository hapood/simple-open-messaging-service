import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { verifyNativeBuild } from './verify-native-build.mjs';

function fixture(
  t,
  inputs = {},
  outputs = {
    'main-ABC.js': { entryPoint: 'src/main.ts' },
  },
) {
  const directory = mkdtempSync(join(tmpdir(), 'soms-native-build-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, 'browser'));
  writeFileSync(
    join(directory, 'stats.json'),
    JSON.stringify({ inputs, outputs }),
  );
  writeFileSync(
    join(directory, 'browser/index.html'),
    '<script src="main-ABC.js"></script>',
  );
  writeFileSync(join(directory, 'browser/main-ABC.js'), 'console.log("AOT");');
  return directory;
}

test('accepts an AOT application without the runtime compiler', (t) => {
  const directory = fixture(t, {
    'node_modules/@angular/core/fesm2022/core.mjs': {},
    'node_modules/@angular/compiler-cli/linker/index.js': {},
    'src/main.ts': {},
  });
  assert.doesNotThrow(() => verifyNativeBuild(directory));
});

for (const compiler of [
  'node_modules/@angular/compiler/fesm2022/compiler.mjs',
  'node_modules/@angular/platform-browser-dynamic/fesm2022/platform-browser-dynamic.mjs',
  'node_modules\\@angular\\compiler\\fesm2022\\compiler.mjs',
]) {
  test(`rejects a runtime compiler: ${compiler}`, (t) => {
    const directory = fixture(t, { [compiler]: {} });
    assert.throws(
      () => verifyNativeBuild(directory),
      /CSP forbids Angular JIT/,
    );
  });
}

test('rejects missing metadata instead of trusting an arbitrary Web build', (t) => {
  const directory = fixture(t);
  rmSync(join(directory, 'stats.json'));
  assert.throws(() => verifyNativeBuild(directory), /stats\.json/);
});

test('rejects metadata without the application entry point', (t) => {
  const directory = fixture(
    t,
    {},
    { 'test.js': { entryPoint: 'src/test.ts' } },
  );
  assert.throws(() => verifyNativeBuild(directory), /application entry point/);
});

test('rejects an index from a different build', (t) => {
  const directory = fixture(t);
  writeFileSync(
    join(directory, 'browser/index.html'),
    '<script src="main-OLD.js"></script>',
  );
  assert.throws(() => verifyNativeBuild(directory), /index does not reference/);
});

test('rejects incomplete build output', (t) => {
  const directory = fixture(
    t,
    {},
    {
      'main-ABC.js': { entryPoint: 'src/main.ts' },
      'chunk-DEF.js': {},
    },
  );
  assert.throws(() => verifyNativeBuild(directory), /chunk-DEF\.js/);
});

test('rejects empty scripts', (t) => {
  const directory = fixture(t);
  writeFileSync(join(directory, 'browser/main-ABC.js'), '');
  assert.throws(() => verifyNativeBuild(directory), /empty script/);
});
