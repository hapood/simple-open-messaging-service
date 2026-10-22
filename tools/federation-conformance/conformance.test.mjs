import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const cli = fileURLToPath(new URL('./conformance.ts', import.meta.url));
const loader = fileURLToPath(import.meta.resolve('tsx'));
const releaseDirectory = process.env.SOMFP_SPEC_DIR;
if (!releaseDirectory)
  throw new Error('Set SOMFP_SPEC_DIR to the protocol release directory');
const vectors = JSON.parse(
  readFileSync(join(releaseDirectory, 'v1/schema/vectors/valid.json'), 'utf8'),
).vectors;
const messagePage = vectors.find(
  (vector) => vector.schema === 'urn:somfp:v1:message-query',
).value;

function workspace(t) {
  const directory = mkdtempSync(join(tmpdir(), 'somfp-validator-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function run(directory, args = [], includeSpec = true) {
  const specArgs = includeSpec ? ['--spec', releaseDirectory] : [];
  return spawnSync(
    process.execPath,
    ['--import', loader, cli, ...specArgs, ...args],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30_000,
      env: { ...process.env, NODE_PATH: '' },
    },
  );
}

function input(directory, value, schema = 'urn:somfp:v1:message-query') {
  const file = join(directory, 'input.json');
  writeFileSync(file, JSON.stringify(value));
  // A relative input path must resolve against the caller, not the release directory.
  return ['--schema', schema, '--file', 'input.json'];
}

test('validates the release from an unrelated working directory', (t) => {
  const result = run(workspace(t));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SOMFP v1 conformance package: PASS/);
});

for (const failure of ['body', 'signature-base', 'root-header']) {
  test(`rejects a cryptographically valid vector with invalid ${failure}`, (t) => {
    const directory = workspace(t);
    const copy = join(directory, 'spec');
    cpSync(releaseDirectory, copy, { recursive: true });
    const path = join(copy, 'v1/schema/vectors/http-message-signature.json');
    const vector = JSON.parse(readFileSync(path, 'utf8'));
    if (failure === 'body') {
      vector.request.body = '{"stateFeedEndId":"12"}';
      const digest = `sha-256=:${createHash('sha256').update(vector.request.body).digest('base64')}:`;
      vector.signatureBase = vector.signatureBase.replace(
        vector.headers['content-digest'],
        digest,
      );
      vector.headers['content-digest'] = digest;
    } else if (failure === 'signature-base') {
      vector.signatureBase = vector.signatureBase.replace(
        'b.example',
        'other.example',
      );
    } else {
      delete vector.headers['s2s-root-key'];
    }
    const key = createPrivateKey({
      key: Buffer.concat([
        Buffer.from('302e020100300506032b657004220420', 'hex'),
        Buffer.from(vector.privateKeyBase64, 'base64'),
      ]),
      format: 'der',
      type: 'pkcs8',
    });
    vector.headers.signature = `sig1=:${sign(null, Buffer.from(vector.signatureBase), key).toString('base64')}:`;
    writeFileSync(path, JSON.stringify(vector));
    const result = run(directory, ['--spec', copy], false);
    assert.equal(result.status, 1, result.stderr);
    assert.match(
      result.stderr,
      /signed operation body|does not reproduce|S2S-Root-Key/,
    );
  });
}

test('validates a real message-page vector including its parsed content', (t) => {
  const directory = workspace(t);
  const result = run(directory, input(directory, messagePage));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /conformant: input.json/);
});

test('rejects a valid envelope containing content outside the content schema', (t) => {
  const directory = workspace(t);
  const page = structuredClone(messagePage);
  page.messages[0].content = JSON.stringify({ unexpected: 'not text content' });
  const result = run(directory, input(directory, page));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /input is not conformant/);
});

test('rejects content that is not encoded JSON', (t) => {
  const directory = workspace(t);
  const page = structuredClone(messagePage);
  page.messages[0].content = 'plain text';
  const result = run(directory, input(directory, page));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /input is not conformant/);
});

for (const malformed of [false, true]) {
  test(`validates parsed content for a message schema fragment (malformed=${malformed})`, (t) => {
    const directory = workspace(t);
    const message = structuredClone(messagePage.messages[0]);
    if (malformed)
      message.content = JSON.stringify({ unexpected: 'not text content' });
    const result = run(
      directory,
      input(directory, message, 'urn:somfp:v1:message-query#/$defs/message'),
    );
    assert.equal(result.status, malformed ? 1 : 0, result.stderr);
  });
}

test('rejects a closed-envelope violation', (t) => {
  const directory = workspace(t);
  const page = structuredClone(messagePage);
  page.messages[0].author.domain = 'not-a-wire-field.test';
  const result = run(directory, input(directory, page));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /input is not conformant/);
});

test('enforces semantic ordering after schema validation', (t) => {
  const directory = workspace(t);
  const page = structuredClone(messagePage);
  page.messages.push(structuredClone(page.messages[0]));
  const result = run(directory, input(directory, page));
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /input is not conformant/);
});

test('requires an explicit release directory', (t) => {
  const result = run(workspace(t), [], false);
  assert.equal(result.status, 1, result.stderr);
  assert.match(
    result.stderr,
    /--spec must name the protocol release directory/,
  );
});

for (const args of [
  ['--spec'],
  ['--schema=', '--file='],
  ['--schema='],
  ['--schema'],
  ['--file'],
  ['--schema', 'urn:somfp:v1:message-query'],
  ['--file', 'input.json'],
  ['--unknown'],
  ['unexpected-positional-input'],
]) {
  test(`rejects invalid CLI arguments: ${args.join(' ')}`, (t) => {
    const result = run(workspace(t), args);
    assert.equal(result.status, 1, result.stderr);
    assert.doesNotMatch(result.stdout, /conformance package: PASS/);
  });
}
