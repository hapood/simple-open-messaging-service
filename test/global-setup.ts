// Runs once before the whole e2e suite: apply pending migrations to soms_test so
// its schema is current. Idempotent — safe to run repeatedly.
import 'dotenv/config';
import { execSync } from 'node:child_process';

function toTestDatabase(url: string): string {
  return url.replace(/^(.*\/)[^/?]*(\?.*)?$/, '$1soms_test$2');
}

export default async function globalSetup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error(
      'DATABASE_URL missing — copy .env.example to .env and configure it.',
    );
  }
  process.env.DATABASE_URL = toTestDatabase(process.env.DATABASE_URL);
  // prisma.config.ts re-loads dotenv, but dotenv does not override an already-set
  // DATABASE_URL, so the soms_test override set above survives into the CLI.
  execSync('npx prisma migrate deploy', { stdio: 'inherit' });
}
