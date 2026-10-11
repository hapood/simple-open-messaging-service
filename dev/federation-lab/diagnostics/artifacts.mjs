import { rmSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const labDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = resolve(labDir, '../..');

/**
 * A diagnostic session names its databases `soms_fed_diag_<timestamp>_<node>`.
 * The shape check keeps operator-created databases that merely share the
 * prefix (for example manual backups) out of the startup purge; the
 * interactive lab's `soms_fed_lab_*` and the e2e suite's `soms_test_*`
 * databases never match.
 */
export function isDiagnosticDatabase(database, nodeNames) {
  return new RegExp(
    `^soms_fed_diag_\\d+(?:_(?:${[...nodeNames].join('|')}))$`,
  ).test(database);
}

/** Resolve the directory that holds one timestamped child directory per run. */
export function diagnosticsRoot(custom = process.env.SOMS_DIAGNOSTICS_DIR) {
  return resolve((custom ?? '').trim() || join(labDir, 'diagnostic-runs'));
}

function isAncestorOrSelf(candidate, path) {
  const relation = relative(candidate, path);
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation));
}

export function formatMegabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}

export async function dropDiagnosticDatabases(client, nodeNames) {
  const candidates = await client.query(
    "SELECT datname, pg_database_size(datname) AS bytes FROM pg_database WHERE datname LIKE 'soms\\_fed\\_diag\\_%'",
  );
  const stale = candidates.rows.filter((row) =>
    isDiagnosticDatabase(row.datname, nodeNames),
  );
  let freedBytes = 0;
  for (const row of stale) {
    freedBytes += Number(row.bytes);
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [row.datname],
    );
    await client.query(`DROP DATABASE IF EXISTS "${row.datname}"`);
    console.log(`[diagnostics] dropped leftover database ${row.datname}`);
  }
  return {
    dropped: stale.length,
    kept: candidates.rows.length - stale.length,
    freedBytes,
  };
}

export function removeDiagnosticRuns(root) {
  // The purge deletes recursively; refuse roots that would take the lab or
  // the repository with them when SOMS_DIAGNOSTICS_DIR is misconfigured.
  if (isAncestorOrSelf(root, labDir) || isAncestorOrSelf(root, repositoryRoot))
    throw new Error(
      `refusing to remove ${root}: the diagnostic output root must not contain the lab or the repository`,
    );
  rmSync(root, { recursive: true, force: true });
  console.log(`[diagnostics] removed ${root}`);
}

/**
 * Drop every leftover `soms_fed_diag_*` database and delete all previous run
 * directories. Only artifacts owned by federation:test are touched: the
 * interactive lab's databases, runtime directory, and `local/` identities are
 * left alone, so a diagnostic session and a running dev lab stay independent.
 * Callers must hold the single-session lock before purging.
 */
export async function purgeDiagnosticArtifacts({
  baseDatabaseUrl,
  nodeNames,
  root = diagnosticsRoot(),
}) {
  const admin = new URL(baseDatabaseUrl);
  admin.pathname = '/postgres';
  const client = new Client({ connectionString: admin.toString() });
  await client.connect();
  let summary;
  try {
    summary = await dropDiagnosticDatabases(client, nodeNames);
  } finally {
    await client.end();
  }
  removeDiagnosticRuns(root);
  return { ...summary, removedDirectory: root };
}
