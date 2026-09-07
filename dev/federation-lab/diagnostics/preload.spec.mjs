import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('records correlated timings without query secrets and preserves pool connect contracts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'lab-diagnostics-'));
  try {
    await promisify(execFile)(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import pg from 'pg';
      import { channel } from 'node:diagnostics_channel';
      const client = {};
      const release = () => {};
      pg.Pool.prototype.connect = function (callback) {
        if (callback) return setTimeout(() => callback(null, client, release), 110);
        return new Promise(resolve => setTimeout(() => resolve(client), 110));
      };
      await import('./dev/federation-lab/diagnostics/preload.mjs');
      const pool = new pg.Pool();
      if (await pool.connect() !== client) throw new Error('promise client changed');
      await new Promise((resolve, reject) => pool.connect((error, value, done) => {
        if (error || value !== client || done !== release) reject(new Error('callback changed'));
        else resolve();
      }));
      const request = { method: 'POST', origin: 'http://127.0.0.1:3202', path: '/api/v1/admin/durable-tasks?token=secret-value' };
      channel('undici:request:create').publish({ request });
      channel('undici:request:headers').publish({ request, response: { statusCode: 200, headers: [Buffer.from('X-Request-Id'), Buffer.from('test-request')] } });
      channel('undici:request:trailers').publish({ request });
      await new Promise(resolve => setTimeout(resolve, 1100));
    `,
      ],
      { env: { ...process.env, SOMS_DIAGNOSTICS_DIR: directory } },
    );
    const [file] = await readdir(directory);
    const raw = await readFile(join(directory, file), 'utf8');
    assert.ok(!raw.includes('secret-value'));
    const records = raw.trim().split('\n').map(JSON.parse);
    assert.equal(
      records.filter(({ type }) => type === 'pool_acquire').length,
      2,
    );
    const completed = records.find(({ type }) => type === 'http_complete');
    assert.equal(completed.requestId, 'test-request');
    assert.equal(completed.path, '/api/v1/admin/durable-tasks');
    assert.ok(completed.elapsedMs >= completed.headersMs);
    assert.ok(records.some(({ type }) => type === 'runtime'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
