// Runs once before the whole e2e suite: apply pending migrations to soms_test so
// its schema is current. Idempotent — safe to run repeatedly.
import 'dotenv/config';
import { ensureDatabase, resetAndMigrateDatabase } from './database.js';

function toTestDatabase(url: string): string {
  return url.replace(/^(.*\/)[^/?]*(\?.*)?$/, '$1soms_test$2');
}

export default async function globalSetup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL missing — copy .env.example to .env and configure it.',
    );
  }
  const testUrl = toTestDatabase(process.env.DATABASE_URL);
  await ensureDatabase(process.env.DATABASE_URL, 'soms_test');
  await resetAndMigrateDatabase(testUrl);
}
