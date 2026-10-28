import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

for (const [surface, path] of [
  ['authentication', '../src/app/assets/utils.scss'],
  ['server setup', '../src/app/pages/server-config-page/server-config-page.component.scss'],
]) {
  test(`${surface} follows viewport height immediately and animates only keyboard occlusion`, () => {
    const styles = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(styles, /height:\s*calc\(100dvh - var\(--auth-keyboard-inset, 0px\)\)/);
    assert.match(styles, /transition:\s*--auth-keyboard-inset 160ms ease-out\s*;/);
    assert.doesNotMatch(
      styles,
      /transition(?:-property)?\s*:[^;]*(?:\bheight\b|\ball\b)/,
      'Easing viewport height during vertical shrinkage can create a temporary document scrollbar and flip the width breakpoint',
    );
  });
}

test('keyboard occlusion is registered globally as an interpolatable inherited length', () => {
  const styles = readFileSync(new URL('../src/styles.scss', import.meta.url), 'utf8');
  const [, registration] = styles.match(/@property\s+--auth-keyboard-inset\s*\{([^}]+)\}/) ?? [];
  assert.ok(registration, 'A custom-property transition needs a global @property registration');
  assert.match(registration, /syntax:\s*['"]<length>['"]\s*;/);
  assert.match(registration, /inherits:\s*true\s*;/);
  assert.match(registration, /initial-value:\s*0px\s*;/);
});
