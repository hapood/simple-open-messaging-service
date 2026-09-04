import { execFileSync } from 'node:child_process';
import { Client } from 'pg';

export function databaseUrl(baseUrl: string, database: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

export async function ensureDatabase(
  baseUrl: string,
  database: string,
): Promise<string> {
  const adminUrl = databaseUrl(baseUrl, 'postgres');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    const exists = await client.query<{ datallowconn: boolean }>(
      'SELECT datallowconn FROM pg_database WHERE datname = $1',
      [database],
    );
    if (exists.rowCount === 0) {
      if (!/^[a-zA-Z0-9_]+$/.test(database)) {
        throw new Error(`unsafe test database name: ${database}`);
      }
      await client.query(`CREATE DATABASE "${database}"`);
    }
    // A previously interrupted template clone may have exited after closing
    // the connection gate but before its finally block reopened it. Avoid an
    // unnecessary ALTER on prepared worker databases because PostgreSQL may
    // transiently expose a clone target as invalid while CREATE DATABASE is
    // still completing in global setup.
    if (exists.rows[0]?.datallowconn === false) {
      await client.query(`ALTER DATABASE "${database}" ALLOW_CONNECTIONS true`);
    }
  } finally {
    await client.end();
  }
  return databaseUrl(baseUrl, database);
}

/**
 * Restore the mutable contents of a prepared worker database before Vitest
 * imports a spec file. The migration ledger and the local namespace sentinel
 * are schema baseline; every other public-table row belongs to a previous spec.
 */
export async function resetE2EWorkerDatabase(
  url: string,
  expectedDatabase: string,
): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const current = await client.query<{ current_database: string }>(
      'SELECT current_database()',
    );
    if (current.rows[0]?.current_database !== expectedDatabase) {
      throw new Error(
        `refusing to reset unexpected database: ${current.rows[0]?.current_database ?? 'unknown'}`,
      );
    }
    const tables = await client.query<{ names: string | null }>(`
      SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename) AS names
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename NOT IN ('schema_migrations', 'IdentityNamespace')
    `);
    await client.query('BEGIN');
    try {
      if (tables.rows[0]?.names) {
        await client.query(
          `TRUNCATE TABLE ${tables.rows[0].names} RESTART IDENTITY CASCADE`,
        );
      }
      await client.query('DELETE FROM "IdentityNamespace" WHERE id <> 0');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } finally {
    await client.end();
  }
}

export async function dropDatabase(
  baseUrl: string,
  database: string,
): Promise<void> {
  if (!/^[a-zA-Z0-9_]+$/.test(database)) {
    throw new Error(`unsafe test database name: ${database}`);
  }
  const adminUrl = databaseUrl(baseUrl, 'postgres');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
      [database],
    );
    await client.query(`DROP DATABASE IF EXISTS "${database}"`);
  } finally {
    await client.end();
  }
}

export async function recreateDatabaseFromTemplate(
  baseUrl: string,
  database: string,
  template: string,
): Promise<string> {
  for (const name of [database, template]) {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) {
      throw new Error(`unsafe test database name: ${name}`);
    }
  }
  const adminUrl = databaseUrl(baseUrl, 'postgres');
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    // TimescaleDB starts a per-database background worker after migrations. It can reconnect to the
    // template between pg_terminate_backend() and CREATE DATABASE ... TEMPLATE, producing 55006 even
    // though no test process is using the database. Close the connection gate for the whole clone.
    await client.query(
      `ALTER DATABASE "${template}" WITH ALLOW_CONNECTIONS false`,
    );
    try {
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ANY($1::text[]) AND pid <> pg_backend_pid()',
        [[database, template]],
      );
      await client.query(`DROP DATABASE IF EXISTS "${database}"`);
      await client.query(
        `CREATE DATABASE "${database}" TEMPLATE "${template}"`,
      );
    } finally {
      await client.query(
        `ALTER DATABASE "${template}" WITH ALLOW_CONNECTIONS true`,
      );
    }
  } finally {
    await client.end();
  }
  return databaseUrl(baseUrl, database);
}

export async function resetAndMigrateDatabase(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  execFileSync('npm', ['run', 'db:migrate'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  });
}
