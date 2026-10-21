import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(
  new URL('./inline-sourcemaps.mjs', import.meta.url),
);

for (const target of ['web', 'native', 'playground']) {
  test(`inlines JS and CSS maps only in the selected ${target} directory and is idempotent`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'soms-sourcemaps-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directories = ['web', 'native', 'playground'].map((name) =>
      join(root, name, 'browser'),
    );
    const map = JSON.stringify({
      version: 3,
      sources: ['fixture.ts'],
      mappings: '',
    });
    const js = 'console.log("fixture");\n//# sourceMappingURL=main.js.map';
    const css = 'body { color: red; }\n/*# sourceMappingURL=styles.css.map */';
    for (const directory of directories) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'main.js'), js);
      writeFileSync(join(directory, 'main.js.map'), map);
      writeFileSync(join(directory, 'styles.css'), css);
      writeFileSync(join(directory, 'styles.css.map'), map);
    }
    const selected = join(root, target, 'browser');
    execFileSync(process.execPath, [script, selected]);
    const inlined = ['main.js', 'styles.css'].map((file) =>
      readFileSync(join(selected, file), 'utf8'),
    );
    const dataUri = `data:application/json;charset=utf-8;base64,${Buffer.from(map).toString('base64')}`;
    for (const source of inlined) assert.ok(source.includes(dataUri));
    for (const directory of directories.filter(
      (directory) => directory !== selected,
    )) {
      assert.equal(readFileSync(join(directory, 'main.js'), 'utf8'), js);
      assert.equal(readFileSync(join(directory, 'styles.css'), 'utf8'), css);
    }
    execFileSync(process.execPath, [script, selected]);
    assert.deepEqual(
      ['main.js', 'styles.css'].map((file) =>
        readFileSync(join(selected, file), 'utf8'),
      ),
      inlined,
    );
  });
}

test('leaves production scripts without maps unchanged', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'soms-sourcemaps-production-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = 'console.log("production");';
  writeFileSync(join(directory, 'main.js'), source);
  execFileSync(process.execPath, [script, directory]);
  assert.equal(readFileSync(join(directory, 'main.js'), 'utf8'), source);
});
