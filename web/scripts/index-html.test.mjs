import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { JSDOM } from 'jsdom';

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
  const { document } = new JSDOM(playground).window;
  const canonicals = document.querySelectorAll('link[rel="canonical"]');
  assert.equal(canonicals.length, 1);
  assert.equal(
    canonicals[0].href,
    'https://hapood.github.io/simple-open-messaging-service/',
  );
  const overview = document.querySelector('.project-overview');
  assert.ok(overview);
  assert.equal(overview.closest('app-root'), null);
  assert.match(
    overview.querySelector('h1').textContent,
    /Simple Open Messaging Service/,
  );
  assert.ok(overview.querySelectorAll('li').length >= 3);
  assert.ok(
    overview.querySelector(
      'a[href="https://github.com/hapood/simple-open-messaging-service"]',
    ),
  );
});
