import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('every registered IPC command has an explicitly granted capability and no stale ACL entry remains', () => {
  const source = readFileSync(resolve(root, 'src-tauri/src/lib.rs'), 'utf8');
  const permissions = readFileSync(resolve(root, 'src-tauri/permissions/app-commands.toml'), 'utf8');

  const handlers = [...source.matchAll(/generate_handler!\s*\[([^\]]+)\]/g)];
  assert.equal(handlers.length, 2, 'check both desktop and mobile handler lists');
  const registered = new Set(handlers.flatMap(([, list]) =>
    [...list.matchAll(/\b\w+::(\w+)\s*,/g)].map((match) => match[1]),
  ));

  const blocks = permissions.split('[[permission]]').slice(1);
  const granted = new Set();
  const permissionIds = new Set();
  for (const block of blocks) {
    const id = block.match(/identifier\s*=\s*"([^"]+)"/)?.[1];
    const allow = block.match(/commands\.allow\s*=\s*\[([^\]]*)\]/)?.[1];
    assert.ok(id && allow !== undefined, 'each permission needs an identifier and command list');
    permissionIds.add(id);
    for (const [, command] of allow.matchAll(/"([a-z][a-z_0-9]+)"/g)) {
      assert.ok(!granted.has(command), `command granted twice: ${command}`);
      granted.add(command);
    }
  }

  const defaults = permissions.split('[default]')[1];
  assert.ok(defaults, 'the webview default capability must exist');
  const defaultIds = new Set([...defaults.matchAll(/"(allow-[a-z-]+)"/g)].map((match) => match[1]));
  assert.deepEqual([...permissionIds].filter((id) => !defaultIds.has(id)).sort(), [], 'permissions omitted from the default capability');
  assert.deepEqual([...defaultIds].filter((id) => !permissionIds.has(id)).sort(), [], 'unknown default permissions');
  assert.deepEqual([...registered].filter((command) => !granted.has(command)).sort(), [], 'registered commands without permission');
  assert.deepEqual([...granted].filter((command) => !registered.has(command)).sort(), [], 'stale permissions without registered command');
});
