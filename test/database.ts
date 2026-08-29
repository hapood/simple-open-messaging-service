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
