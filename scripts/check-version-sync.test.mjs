import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const newline of ['\n', '\r\n']) {
  test(`version validation accepts ${newline === '\n' ? 'LF' : 'CRLF'} Cargo files`, () => {
    const root = mkdtempSync(join(tmpdir(), 'soms-version-'));
    try {
      for (const file of [
        'package.json',
        'package-lock.json',
        'web/package.json',
        'web/package-lock.json',
        'admin-web/package.json',
        'admin-web/package-lock.json',
        'src-tauri/tauri.conf.json',
        'src-tauri/Cargo.toml',
        'src-tauri/Cargo.lock',
      ]) {
        const destination = join(root, file);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(file, destination);
        if (file.includes('Cargo.')) {
          writeFileSync(
            destination,
            readFileSync(destination, 'utf8').replace(/\r?\n/g, newline),
          );
        }
      }
      const result = spawnSync(
        process.execPath,
        [resolve('scripts/check-version-sync.mjs')],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /SOMS version synchronized/);
      writeFileSync(
        join(root, 'src-tauri/Cargo.lock'),
        `name = "soms-client"${newline}version = "0.0.0"${newline}`,
      );
      const mismatch = spawnSync(
        process.execPath,
        [resolve('scripts/check-version-sync.mjs')],
        {
          cwd: root,
          encoding: 'utf8',
          timeout: 10000,
        },
      );
      assert.equal(mismatch.status, 1);
      assert.match(mismatch.stderr, /Cargo.lock: 0.0.0/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
