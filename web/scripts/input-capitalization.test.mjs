import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseFragment } from 'parse5';

const templates = [
  ['components/login/login.component.html', 4],
  ['components/register/register.component.html', 3],
  ['pages/set-password-page/set-password-page.component.html', 2],
  ['pages/server-config-page/server-config-page.component.html', 1],
];

function inputs(node) {
  return (node.childNodes ?? []).flatMap((child) => [
    ...(child.tagName === 'input' ? [child] : []),
    ...inputs(child),
  ]);
}

const searchTemplates = [
  ['components/thread-search-input/thread-search-input.component.html', ''],
  ['components/identity-search/identity-search.component.html', 'search-input'],
  ['components/message-search/message-search.component.ts', 'msg-search-input'],
  ['components/debug-log/debug-log-overlay.component.ts', 'dbg-search'],
  ['components/group-info/group-info.component.html', 'member-search'],
];

for (const [path, className] of searchTemplates) {
  test(`${path} disables search capitalization`, () => {
    const source = readFileSync(new URL(`../src/app/${path}`, import.meta.url), 'utf8');
    const fields = [...source.matchAll(/<input\b[\s\S]*?\/>/g)]
      .flatMap(([markup]) => inputs(parseFragment(markup)))
      .filter((field) => !className || field.attrs.some(
        (attr) => attr.name === 'class' && attr.value.split(/\s+/).includes(className),
      ));
    assert.equal(fields.length, 1);
    assert.ok(fields[0].attrs.some((attr) => attr.name === 'autocapitalize' && attr.value === 'off'));
  });
}

for (const [path, count] of templates) {
  test(`${path} disables automatic capitalization for exact-value input`, () => {
    const html = readFileSync(new URL(`../src/app/${path}`, import.meta.url), 'utf8');
    const fields = inputs(parseFragment(html));
    assert.equal(fields.length, count);
    for (const field of fields) {
      const attrs = Object.fromEntries(field.attrs.map(({ name, value }) => [name, value]));
      assert.equal(attrs.autocapitalize, 'off', attrs.name ?? attrs.type);
      assert.ok(attrs.autocomplete, 'Keep the existing autofill purpose');
    }
  });
}
