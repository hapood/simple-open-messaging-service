import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  diagnosticsRoot,
  dropDiagnosticDatabases,
  formatMegabytes,
  isDiagnosticDatabase,
  removeDiagnosticRuns,
} from './artifacts.mjs';

const labDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const nodeNames = ['alpha', 'bravo', 'charlie'];

test('isDiagnosticDatabase matches only diagnostic session database names', () => {
  assert.equal(
    isDiagnosticDatabase('soms_fed_diag_20261008042625597_alpha', nodeNames),
    true,
  );
  assert.equal(
    isDiagnosticDatabase('soms_fed_diag_20261008042625597_charlie', nodeNames),
    true,
  );
});

test('isDiagnosticDatabase rejects lab, e2e, and manually named databases', () => {
  assert.equal(isDiagnosticDatabase('soms_fed_lab_alpha', nodeNames), false);
  assert.equal(isDiagnosticDatabase('soms_test_alpha', nodeNames), false);
  assert.equal(
    isDiagnosticDatabase('soms_fed_diag_20261008042625597', nodeNames),
    false,
  );
  assert.equal(
    isDiagnosticDatabase('soms_fed_diag_manual_backup', nodeNames),
    false,
  );
  assert.equal(
    isDiagnosticDatabase('soms_fed_diag_20261008042625597_alpha_backup', nodeNames),
    false,
  );
});

test('diagnosticsRoot defaults into the lab and honors SOMS_DIAGNOSTICS_DIR', () => {
  assert.equal(diagnosticsRoot(undefined), join(labDir, 'diagnostic-runs'));
  assert.equal(
    diagnosticsRoot('/tmp/custom-runs'),
    resolve('/tmp/custom-runs'),
  );
  assert.equal(diagnosticsRoot('  '), join(labDir, 'diagnostic-runs'));
});

test('dropDiagnosticDatabases drops only shape-matching leftovers and reports freed bytes', async () => {
  const queries = [];
  const client = {
    async query(sql, parameters) {
      queries.push([sql, parameters]);
      if (sql.startsWith('SELECT datname'))
        return {
          rows: [
            { datname: 'soms_fed_diag_20261008042625597_alpha', bytes: '100' },
            { datname: 'soms_fed_diag_manual_backup', bytes: '50' },
            { datname: 'soms_fed_lab_alpha', bytes: '10' },
          ],
        };
      return { rows: [] };
    },
  };
  const summary = await dropDiagnosticDatabases(client, nodeNames);
  assert.deepEqual(
    { dropped: summary.dropped, kept: summary.kept, freedBytes: summary.freedBytes },
    { dropped: 1, kept: 2, freedBytes: 100 },
  );
  assert.deepEqual(
    queries.filter(([sql]) => sql.startsWith('SELECT pg_terminate_backend')),
    [
      [
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
        ['soms_fed_diag_20261008042625597_alpha'],
      ],
    ],
  );
  assert.deepEqual(
    queries.filter(([sql]) => sql.startsWith('DROP DATABASE')),
    [['DROP DATABASE IF EXISTS "soms_fed_diag_20261008042625597_alpha"', undefined]],
  );
});

test('removeDiagnosticRuns deletes the directory tree but refuses lab and repository roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lab-artifacts-'));
  await mkdir(join(root, 'run'), { recursive: true });
  await writeFile(join(root, 'run', 'session.json'), '{}\n');
  removeDiagnosticRuns(root);
  assert.equal(existsSync(root), false);

  for (const dangerous of [labDir, dirname(labDir), resolve('/')]) {
    assert.throws(
      () => removeDiagnosticRuns(dangerous),
      /refusing to remove .*: the diagnostic output root must not contain/,
    );
  }
});

test('formatMegabytes rounds to whole megabytes', () => {
  assert.equal(formatMegabytes(0), '0 MB');
  assert.equal(formatMegabytes(1024 * 1024 * 3 + 100_000), '3 MB');
});
