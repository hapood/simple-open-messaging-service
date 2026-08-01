import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Pool, type PoolClient } from 'pg';

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
        AND tablename NOT IN ('schema_migrations', '_prisma_migrations')
    ) AS exists
  `);
  return result.rows[0]?.exists ?? false;
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
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    await client.query(
      'INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)',
      [migration.version, migration.checksum],
    );
    console.log(`baselined ${migration.version}`);
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

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const command = process.argv[2] ?? 'migrate';
  if (!['migrate', 'baseline', 'status'].includes(command)) {
    throw new Error(`unknown command: ${command}`);
  }

  const pool = new Pool({ connectionString: url, max: 1 });
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
