import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const styles = readFileSync(new URL('../src/styles.scss', import.meta.url), 'utf8');

for (const [selector, declaration] of [
  ['*', /scrollbar-width:\s*none\s*;/],
  ['*::-webkit-scrollbar', /display:\s*none\s*;/],
]) {
  test(`global ${selector} hides native scrollbar chrome without disabling scrolling`, () => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const [, rule] = styles.match(new RegExp(`^${escaped}\\s*\\{([^}]+)\\}`, 'm')) ?? [];
    assert.ok(rule, 'Scrollbar hiding must apply globally, including document and nested scrollers');
    assert.match(rule, declaration);
    assert.doesNotMatch(rule, /\boverflow(?:-[xy])?\s*:/, 'Existing scroll containers must keep their overflow policy');
  });
}
