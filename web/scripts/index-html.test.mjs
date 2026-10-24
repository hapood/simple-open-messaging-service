import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');

test('declares the document base before loading the pre-paint bootstrap', () => {
  const base = html.indexOf('<base href="/"');
  const bootstrap = html.indexOf('<script src="boot.js"');
  assert.ok(base >= 0, 'The application must declare its document base');
  assert.ok(bootstrap > base, 'Deep-link reloads must resolve boot.js against the application base');
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
