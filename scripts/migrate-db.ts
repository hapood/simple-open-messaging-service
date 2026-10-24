import 'dotenv/config';
import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { readFileSync } from 'node:fs';

const MIGRATIONS_DIR = join(process.cwd(), 'database', 'migrations');
const LOCK_NAME = 'soms-schema-migrations';

interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

async function loadMigrations(): Promise<Migration[]> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  return Promise.all(
    files.map(async (file) => {
      const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
      return {
        version: basename(file, '.sql'),
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    }),
  );
}

async function ensureLedger(client: PoolClient): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function readApplied(client: PoolClient): Promise<Map<string, string>> {
  const result = await client.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations ORDER BY version',
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}

function verifyChecksums(
  migrations: Migration[],
  applied: Map<string, string>,
): void {
  const known = new Map(
    migrations.map((migration) => [migration.version, migration]),
  );
  for (const [version, checksum] of applied) {
    const migration = known.get(version);
    if (!migration) {
      throw new Error(`applied migration is missing from disk: ${version}`);
    }
    if (migration.checksum !== checksum) {
      throw new Error(`applied migration was modified: ${version}`);
    }
  }
}

async function hasExistingSchema(client: PoolClient): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(`
    SELECT EXISTS (
      SELECT 1
      FROM pg_tables
      WHERE schemaname = current_schema()
        AND tablename <> 'schema_migrations'
    ) AS exists
  `);
  return result.rows[0]?.exists ?? false;
}

async function schemaSignature(
  client: PoolClient,
  schema: string,
): Promise<string[]> {
  await client.query(`SET LOCAL search_path TO "${schema}", pg_catalog`);
  const result = await client.query<{ signature: string }>(
    `
    WITH objects AS (
      SELECT 'column|' || c.relname || '|' || a.attnum || '|' || a.attname ||
             '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull ||
             '|' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') AS signature
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p')
         AND c.relname <> 'schema_migrations'
         AND a.attnum > 0 AND NOT a.attisdropped
      UNION ALL
      SELECT 'constraint|' || c.relname || '|' || con.conname || '|' ||
             con.contype::text || '|' || pg_get_constraintdef(con.oid, true)
        FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1
         AND c.relname <> 'schema_migrations'
      UNION ALL
      SELECT 'index|' || t.relname || '|' || i.relname || '|' ||
             pg_get_indexdef(i.oid)
        FROM pg_index x
        JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_class t ON t.oid = x.indrelid
       JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = $1
         AND t.relname <> 'schema_migrations'
      UNION ALL
      SELECT 'enum|' || typ.typname || '|' || e.enumsortorder || '|' || e.enumlabel
        FROM pg_type typ
        JOIN pg_namespace n ON n.oid = typ.typnamespace
        JOIN pg_enum e ON e.enumtypid = typ.oid
       WHERE n.nspname = $1
    )
    SELECT replace(replace(signature, quote_ident($1) || '.', ''), $1 || '.', '')
           AS signature
      FROM objects
     ORDER BY signature
  `,
    [schema],
  );
  return result.rows.map((row) => row.signature);
}

async function verifySchemaParity(
  client: PoolClient,
  migrations: Migration[],
): Promise<void> {
  const reference = `soms_reference_${randomUUID().replaceAll('-', '')}`;
  await client.query(`CREATE SCHEMA "${reference}"`);
  await client.query(`SET LOCAL search_path TO "${reference}", pg_catalog`);
  for (const migration of migrations) await client.query(migration.sql);

  const actual = await schemaSignature(client, 'public');
  const expected = await schemaSignature(client, reference);
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  const missing = expected.filter((item) => !actualSet.has(item));
  const extra = actual.filter((item) => !expectedSet.has(item));
  if (missing.length || extra.length) {
    const sample = [
      ...missing.slice(0, 10).map((item) => `missing: ${item}`),
      ...extra.slice(0, 10).map((item) => `extra: ${item}`),
    ].join('\n');
    throw new Error(
      `database schema differs from SQL baseline (${missing.length} missing, ${extra.length} extra)\n${sample}`,
    );
  }
}

async function migrate(
  client: PoolClient,
  migrations: Migration[],
): Promise<void> {
  const applied = await readApplied(client);
  verifyChecksums(migrations, applied);
  const pending = migrations.filter(({ version }) => !applied.has(version));
  if (
    pending.length > 0 &&
    applied.size === 0 &&
    (await hasExistingSchema(client))
  ) {
    throw new Error(
      'database already has tables but no SQL migration history; run `npm run db:baseline` once after verifying its schema',
    );
  }
  for (const migration of pending) {
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum],
      );
      await client.query('COMMIT');
      console.log(`applied ${migration.version}`);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }
  if (pending.length === 0) console.log('database schema is up to date');
}

async function baseline(
  client: PoolClient,
  migrations: Migration[],
): Promise<void> {
  if (!(await hasExistingSchema(client))) {
    throw new Error('database is empty; run `npm run db:migrate` instead');
  }
  const applied = await readApplied(client);
  verifyChecksums(migrations, applied);
  const pending = migrations.filter(({ version }) => !applied.has(version));
  if (pending.length === 0) {
    console.log('database schema is already baselined');
    return;
  }
  await client.query('BEGIN');
  try {
    await verifySchemaParity(client, migrations);
    await client.query('SET LOCAL search_path TO public, pg_catalog');
    for (const migration of pending) {
      await client.query(
        'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum],
      );
      console.log(`baselined ${migration.version}`);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function status(
  client: PoolClient,
  migrations: Migration[],
): Promise<void> {
  const applied = await readApplied(client);
  verifyChecksums(migrations, applied);
  for (const migration of migrations) {
    console.log(
      `${applied.has(migration.version) ? 'applied' : 'pending'}  ${migration.version}`,
    );
  }
}

/** TLS options shared by every pool this script builds (remote databases may require them). */
function sslOptions() {
  return process.env.SOMS_DB_TLS === 'verify-full'
    ? {
        ssl: {
          rejectUnauthorized: true,
          ...(process.env.SOMS_DB_CA_FILE
            ? { ca: readFileSync(process.env.SOMS_DB_CA_FILE, 'utf8') }
            : {}),
        },
      }
    : {};
}

/** Connection-level failures that are EXPECTED while a database or network is still
 *  coming up; everything else (bad credentials, SSL misconfiguration, SQL errors) is a
 *  deployment misconfiguration and fails fast instead of burning the retry budget. */
const TRANSIENT_CODES = new Set([
  'ECONNREFUSED',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNRESET',
  'EPIPE',
]);
function isTransientError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (typeof code === 'string' && TRANSIENT_CODES.has(code)) return true;
  // PostgreSQL answers "cannot_connect_now" (57P03) while starting up or in recovery.
  return code === '57P03';
}

/** Connectivity gate for the container bootstrap: retry SELECT 1 until the server answers or the
 *  deadline passes. Uses the SAME connection configuration as the real pool (DATABASE_URL or
 *  PG* variables, TLS options), so "ready" means the app will actually connect — a TCP probe
 * could not vouch for credentials or TLS. Transient connection failures retry in-process; any
 * other error is a misconfiguration and exits immediately. */
async function waitForDatabase(
  connectionString: string | undefined,
): Promise<void> {
  const timeoutSec = Math.min(
    Math.max(Number(process.env.SOMS_DB_WAIT_TIMEOUT_SEC ?? 120) || 120, 1),
    3600,
  );
  const deadline = Date.now() + timeoutSec * 1000;
  const intervalMs = 2000;
  const pool = new Pool({
    ...(connectionString ? { connectionString } : {}),
    ...sslOptions(),
    max: 1,
  });
  let attempt = 0;
  let lastError = 'unknown';
  try {
    for (;;) {
      attempt += 1;
      try {
        const client = await pool.connect();
        try {
          await client.query('SELECT 1');
        } finally {
          client.release();
        }
        console.log(
          `database accepts connections (attempt ${attempt}, ${timeoutSec}s budget)`,
        );
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
        if (!isTransientError(error)) {
          throw new Error(
            `database connection failed on attempt ${attempt} (not retryable): ${lastError}`,
          );
        }
        if (Date.now() + intervalMs >= deadline) break;
        console.log(
          `database not ready (attempt ${attempt}: ${lastError}); retrying in 2s`,
        );
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    }
  } finally {
    await pool.end();
  }
  throw new Error(
    `database not accepting connections within ${timeoutSec}s (${attempt} attempts, last error: ${lastError})`,
  );
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL?.trim() || undefined;
  if (!connectionString) {
    const missing = ['PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'].filter(
      (name) => !process.env[name]?.trim(),
    );
    if (missing.length > 0) {
      throw new Error(
        `DATABASE_URL or standard PostgreSQL variables are required (missing: ${missing.join(', ')})`,
      );
    }
  }
  const command = process.argv[2] ?? 'migrate';
  if (!['migrate', 'baseline', 'status', 'wait'].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }
  if (command === 'wait') {
    await waitForDatabase(connectionString);
    return;
  }

  const pool = new Pool({
    ...(connectionString ? { connectionString } : {}),
    ...sslOptions(),
    max: 1,
    options: '-c timezone=UTC',
  });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [LOCK_NAME]);
    await ensureLedger(client);
    const migrations = await loadMigrations();
    if (command === 'migrate') await migrate(client, migrations);
    else if (command === 'baseline') await baseline(client, migrations);
    else await status(client, migrations);
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', [LOCK_NAME]);
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
