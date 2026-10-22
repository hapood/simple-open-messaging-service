import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeHmrSession } from './hmr-session.mjs';

test('new lab replaces stale identity while recovery preserves the running identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'soms-hmr-session-'));
  const path = join(root, 'session.json');
  const read = () => JSON.parse(readFileSync(path, 'utf8'));
  try {
    writeHmrSession(root, 'old', 1, true);
    writeHmrSession(root, 'new', 2, true);
    assert.equal(read().sessionId, 'new');
    writeHmrSession(root, 'other', 3);
    assert.equal(read().sessionId, 'new');
    rmSync(path);
    writeHmrSession(root, 'new', 2);
    assert.deepEqual(read(), { sessionId: 'new', pid: 2, startedAt: 'new' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
