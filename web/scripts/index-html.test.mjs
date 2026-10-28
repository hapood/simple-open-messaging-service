import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'parse5';

function elements(node) {
  return (node.childNodes ?? []).flatMap((child) => [
    ...(child.tagName ? [child] : []),
    ...elements(child),
  ]);
}

function attribute(node, name) {
  return node.attrs.find((attr) => attr.name === name)?.value;
}

function textContent(node) {
  return node.nodeName === '#text'
    ? node.value
    : (node.childNodes ?? []).map(textContent).join('');
}

const html = readFileSync(
  new URL('../src/index.html', import.meta.url),
  'utf8',
);

test('declares the document base before loading the pre-paint bootstrap', () => {
  const base = html.indexOf('<base href="/"');
  const bootstrap = html.indexOf('<script src="boot.js"');
  assert.ok(base >= 0, 'The application must declare its document base');
  assert.ok(
    bootstrap > base,
    'Deep-link reloads must resolve boot.js against the application base',
  );
});

test('keeps the pre-paint bootstrap relative for subdirectory deployments', () => {
  const [, source] = html.match(/<script\s+src="([^"]+)"/) ?? [];
  assert.equal(source, 'boot.js');
  for (const base of ['/', '/simple-open-messaging-service/']) {
    const documentUrl = new URL(`${base}auth/qr`, 'https://example.test');
    const baseUrl = new URL(base, documentUrl);
    assert.equal(new URL(source, baseUrl).pathname, `${base}boot.js`);
  }
});

test('all playground build modes use the dedicated public HTML entry', () => {
  const config = JSON.parse(
    readFileSync(new URL('../angular.json', import.meta.url), 'utf8'),
  );
  const build = config.projects.web.architect.build;
  for (const mode of [
    'playground',
    'playground-development',
    'playground-output',
  ]) {
    assert.equal(build.configurations[mode].index, 'src/playground/index.html');
  }
  assert.equal(build.options.index, 'src/index.html');
  assert.doesNotMatch(html, /rel="canonical"/);
});

test('playground canonical and project content are available without JavaScript', () => {
  const playground = readFileSync(
    new URL('../src/playground/index.html', import.meta.url),
    'utf8',
  );
  const nodes = elements(parse(playground));
  const canonicals = nodes.filter(
    (node) =>
      node.tagName === 'link' &&
      attribute(node, 'rel')?.split(/\s+/).includes('canonical'),
  );
  assert.equal(canonicals.length, 1);
  assert.equal(
    attribute(canonicals[0], 'href'),
    'https://hapood.github.io/simple-open-messaging-service/',
  );
  const overview = nodes.find((node) =>
    attribute(node, 'class')?.split(/\s+/).includes('project-overview'),
  );
  assert.ok(overview);
  for (let ancestor = overview; ancestor; ancestor = ancestor.parentNode) {
    assert.notEqual(ancestor.tagName, 'app-root');
  }
  const content = elements(overview);
  const heading = content.find((node) => node.tagName === 'h1');
  assert.ok(heading);
  assert.match(textContent(heading), /Simple Open Messaging Service/);
  assert.ok(content.filter((node) => node.tagName === 'li').length >= 3);
  assert.ok(
    content.some(
      (node) =>
        node.tagName === 'a' &&
        attribute(node, 'href') ===
          'https://github.com/hapood/simple-open-messaging-service',
    ),
  );
});
