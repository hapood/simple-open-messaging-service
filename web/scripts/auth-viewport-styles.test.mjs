import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

for (const [surface, path] of [
  ['authentication', '../src/app/assets/utils.scss'],
  ['server setup', '../src/app/pages/server-config-page/server-config-page.component.scss'],
]) {
  test(`${surface} follows viewport height immediately and animates only focused-field lift`, () => {
    const styles = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(styles, /height:\s*100dvh\s*;/);
    assert.match(styles, /transform:\s*translateY\(calc\(-1 \* var\(--auth-focused-lift, 0px\)\)\)\s*;/);
    assert.match(styles, /transition:\s*transform 160ms ease-out\s*;/);
    assert.doesNotMatch(styles, /--auth-keyboard-inset/);
    assert.doesNotMatch(
      styles,
      /transition(?:-property)?\s*:[^;]*(?:\bheight\b|\ball\b)/,
      'Easing viewport height during vertical shrinkage can create a temporary document scrollbar and flip the width breakpoint',
    );
  });
}

test('auth grid and login host shrink within narrow viewports', () => {
  const shell = readFileSync(new URL('../src/app/assets/utils.scss', import.meta.url), 'utf8');
  const login = readFileSync(new URL('../src/app/components/login/login.component.scss', import.meta.url), 'utf8');
  assert.match(shell, /@media \(max-width: 899px\)\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(shell, /\.form-pane\s*\{[^}]*min-width: 0/);
  assert.match(login, /:host\s*\{[^}]*width: 100%;[^}]*max-width: 400px;[^}]*min-width: 0;/);
});

test('server card and fields may shrink below their intrinsic widths', () => {
  const styles = readFileSync(new URL('../src/app/pages/server-config-page/server-config-page.component.scss', import.meta.url), 'utf8');
  assert.match(styles, /\.cfg-shell\s*\{[^}]*width: 100%;[^}]*max-width: 380px;[^}]*min-width: 0;/);
  assert.match(styles, /\.cfg-field\s*\{[^}]*width: 100%;[^}]*min-width: 0;/);
});

test('focused-field lift replaces the global keyboard-height animation property', () => {
  const styles = readFileSync(new URL('../src/styles.scss', import.meta.url), 'utf8');
  assert.doesNotMatch(styles, /--auth-keyboard-inset/);
  const login = readFileSync(new URL('../src/app/components/login/login.component.scss', import.meta.url), 'utf8');
  assert.match(login, /transform:\s*translateY\(calc\(-1 \* var\(--auth-focused-lift, 0px\)\)\)\s*;/);
  assert.match(login, /transition:\s*transform 160ms ease-out\s*;/);
});
