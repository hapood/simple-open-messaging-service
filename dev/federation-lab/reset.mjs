import 'dotenv/config';
import { rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { federationLabNodes } from './topology.mjs';

const labDir = dirname(fileURLToPath(import.meta.url));
const baseDatabaseUrl = process.env.DATABASE_URL?.trim();
if (!baseDatabaseUrl)
  throw new Error('DATABASE_URL is required in the repository .env');

const databases = federationLabNodes.map((node) => node.database);
const admin = new URL(baseDatabaseUrl);
admin.pathname = '/postgres';
const client = new Client({ connectionString: admin.toString() });
await client.connect();
try {
  for (const database of databases) {
    await client.query(
      'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1',
      [database],
    );
    await client.query(`DROP DATABASE IF EXISTS "${database}"`);
    console.log(`dropped ${database}`);
  }
} finally {
  await client.end();
}
rmSync(resolve(labDir, 'runtime'), { recursive: true, force: true });
console.log(`removed ${join(labDir, 'runtime')}`);
