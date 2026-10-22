import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureLabDatabase } from './database.mjs';

test('reuses an existing database without modifying it or disconnecting clients', async () => {
  const queries = [];
  const client = {
    async query(sql, parameters) {
      queries.push([sql, parameters]);
      return { rows: [{ '?column?': 1 }] };
    },
  };

  assert.equal(await ensureLabDatabase(client, 'soms_fed_lab_a'), false);
  assert.deepEqual(queries, [
    ['SELECT 1 FROM pg_database WHERE datname = $1', ['soms_fed_lab_a']],
  ]);
});

test('creates a missing database once and preserves it on subsequent startup', async () => {
  let exists = false;
  let creations = 0;
  const client = {
    async query(sql) {
      if (sql === 'SELECT 1 FROM pg_database WHERE datname = $1') {
        return { rows: exists ? [{}] : [] };
      }
      assert.equal(sql, 'CREATE DATABASE "soms_fed_lab_a"');
      assert.equal(exists, false);
      exists = true;
      creations += 1;
    },
  };

  assert.equal(await ensureLabDatabase(client, 'soms_fed_lab_a'), true);
  assert.equal(await ensureLabDatabase(client, 'soms_fed_lab_a'), false);
  assert.equal(creations, 1);
});

test('propagates database errors without attempting destructive recovery', async () => {
  const error = new Error('permission denied');
  let queries = 0;
  const client = {
    async query() {
      queries += 1;
      throw error;
    },
  };

  await assert.rejects(ensureLabDatabase(client, 'soms_fed_lab_a'), error);
  assert.equal(queries, 1);
});
