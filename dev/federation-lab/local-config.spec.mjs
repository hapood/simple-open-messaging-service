import assert from 'node:assert/strict';
import test from 'node:test';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  existsSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareLabConfig } from './local-config.mjs';

test('preserves isolated credentials across runtime removal without importing mutable data', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'lab-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const node of ['alpha', 'bravo']) {
    const data = join(root, 'runtime', node, 'data');
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, 'vapid-key.json'), node);
    writeFileSync(join(data, 'password-pepper.key'), `${node}-pepper`);
    mkdirSync(join(data, 'uploads'));
    const config = prepareLabConfig(root, node);
    assert.equal(readFileSync(join(config, 'vapid-key.json'), 'utf8'), node);
    assert.equal(statSync(join(config, 'vapid-key.json')).mode & 0o777, 0o600);
    assert.equal(existsSync(join(config, 'uploads')), false);
    writeFileSync(join(config, 'vapid-key.json'), `${node}-updated`);
    prepareLabConfig(root, node);
    assert.equal(
      readFileSync(join(config, 'vapid-key.json'), 'utf8'),
      `${node}-updated`,
    );
  }
  rmSync(join(root, 'runtime'), { recursive: true });
  for (const node of ['alpha', 'bravo']) {
    const config = prepareLabConfig(root, node);
    assert.equal(
      readFileSync(join(config, 'vapid-key.json'), 'utf8'),
      `${node}-updated`,
    );
    assert.equal(
      readFileSync(join(config, 'password-pepper.key'), 'utf8'),
      `${node}-pepper`,
    );
  }
  const fresh = prepareLabConfig(root, 'charlie');
  assert.equal(existsSync(join(fresh, 'vapid-key.json')), false);
});
