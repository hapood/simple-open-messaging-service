import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./check.mjs', import.meta.url));

async function fixture(t, files) {
  const directory = await mkdtemp(join(tmpdir(), 'soms-cycle-check-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    const path = join(directory, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }
  return directory;
}

function run(directory) {
  return spawnSync(process.execPath, [script, directory], {
    encoding: 'utf8',
    cwd: tmpdir(),
    timeout: 30000,
  });
}

test('resolves conditional package exports without a main entry', async (t) => {
  const directory = await fixture(t, {
    'a.ts': "import { value } from 'exports-only'; export const result = value;",
    'node_modules/exports-only/package.json': JSON.stringify({
      name: 'exports-only',
      version: '1.0.0',
      exports: { import: './index.js', require: './index.cjs' },
    }),
    'node_modules/exports-only/index.js': 'export const value = 1;',
    'node_modules/exports-only/index.cjs': 'exports.value = 1;',
  });
  const result = run(directory);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No circular or unresolved dependencies found/);
});

test('returns failure and prints a real source cycle', async (t) => {
  const directory = await fixture(t, {
    'a.ts': "import './b.js'; export const a = 1;",
    'b.ts': "import './a.js'; export const b = 1;",
  });
  const result = run(directory);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Circular dependency:.*a\.ts.*b\.ts/);
});

test('detects type-only cycles as well as runtime imports', async (t) => {
  const directory = await fixture(t, {
    'a.ts': "import type { B } from './b.js'; export interface A { b: B; }",
    'b.ts': "import type { A } from './a.js'; export interface B { a: A; }",
  });
  const result = run(directory);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Circular dependency:.*a\.ts.*b\.ts/);
});

test('rejects an empty source directory instead of passing an empty graph', async (t) => {
  const directory = await fixture(t, {});
  const result = run(directory);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No TypeScript source files found/);
});

test('reports analysis errors for a missing source directory', async (t) => {
  const directory = await fixture(t, {});
  const result = run(join(directory, 'missing'));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ENOENT/);
});

test('fails rather than silently skipping unresolved imports', async (t) => {
  const directory = await fixture(t, {
    'a.ts': "import { value } from 'missing-cycle-check-package'; export { value };",
  });
  const result = run(directory);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unresolved dependency: missing-cycle-check-package/);
});
