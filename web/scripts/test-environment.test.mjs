import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

function specs(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = new URL(
      entry.name + (entry.isDirectory() ? '/' : ''),
      directory,
    );
    return entry.isDirectory()
      ? specs(path)
      : entry.name.endsWith('.spec.ts')
        ? [path]
        : [];
  });
}

test('Angular tests explicitly run in headless Chromium rather than an implicit DOM emulator', () => {
  const angular = JSON.parse(read('../angular.json'));
  const options = angular.projects.web.architect.test.options;
  assert.equal(options.runner, 'vitest');
  assert.deepEqual(options.browsers, ['chromium']);
  assert.equal(options.headless, true);
  assert.equal(options.isolate, true);
});

test('test dependencies use the browser provider and a static HTML parser', () => {
  const { devDependencies, scripts } = JSON.parse(read('../package.json'));
  for (const dependency of ['jsdom', 'happy-dom', 'undici', 'fake-indexeddb']) {
    assert.equal(devDependencies[dependency], undefined);
  }
  for (const dependency of [
    '@vitest/browser-playwright',
    'playwright',
    'parse5',
  ]) {
    assert.ok(
      devDependencies[dependency],
      `${dependency} must be an explicit dependency`,
    );
  }
  assert.equal(
    devDependencies.vitest,
    devDependencies['@vitest/browser-playwright'],
  );
  assert.equal(scripts['test:browser:install'], 'playwright install chromium');
  assert.match(scripts.test, /--watch=false/);
  assert.doesNotMatch(
    read('./index-html.test.mjs'),
    /\bJSDOM\b|from ['"]jsdom['"]/,
  );
});

test('browser specs do not override their environment with a DOM emulator', () => {
  for (const path of specs(new URL('../src/', import.meta.url))) {
    assert.doesNotMatch(
      readFileSync(path, 'utf8'),
      /@vitest-environment\s+(?:jsdom|happy-dom)|from\s+['"]fake-indexeddb|import\s+['"]fake-indexeddb/,
      `${path.pathname} must use the Angular browser runner`,
    );
  }
});
