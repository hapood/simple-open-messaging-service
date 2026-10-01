// Standalone setup for the round-trip e2e: create + migrate a fork database without globalSetup
// (which runs a full tsc over the WIP tree and is blocked by unrelated pre-existing errors).
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import {
  ensureDatabase,
  resetE2EWorkerDatabase,
  resetAndMigrateDatabase,
} from './database.js';
import {
  e2eRunId,
  e2eWorkerDatabaseName,
} from './e2e-database-names.js';

process.env.SOMS_E2E_RUN_ID ??= randomBytes(6).toString('hex');

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL missing — copy .env.example to .env and configure it.',
  );
}

const poolId = process.env.VITEST_POOL_ID ?? '0';
const forkDb = e2eWorkerDatabaseName(poolId);
const forkUrl = await ensureDatabase(process.env.DATABASE_URL, forkDb);
// First run: schema is absent. Migrate idempotently (resetAndMigrateDatabase drops + recreates).
await resetAndMigrateDatabase(forkUrl);
await resetE2EWorkerDatabase(forkUrl, forkDb);
process.env.DATABASE_URL = forkUrl;
