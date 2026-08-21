// E2E environment bootstrap — runs in each vitest worker (fork) before tests.
//
// Loads the dev `.env` for JWT secrets, then gives each parallel fork its OWN database
// (`soms_test_fork<poolId>`) so concurrent e2e files never race on a shared table. Every e2e file
// TRUNCATEs `User` in its setup — if they shared one DB, one fork's TRUNCATE would wipe another's
// just-seeded user mid-test (observed as spurious 401s). Per-fork DBs make that impossible.
//
// The fork DBs persist across runs: the SQL migration runner is idempotent, so an existing fork DB
// is reused (no orphans accumulate). global-setup only ensures the base `soms_test` is reachable.
import 'dotenv/config';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDatabase, resetAndMigrateDatabase } from './database.js';

if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL missing — copy .env.example to .env and configure it.',
  );
}

const poolId = process.env.VITEST_POOL_ID ?? '0';
const forkDb = `soms_test_fork${poolId}`;

const forkUrl = await ensureDatabase(process.env.DATABASE_URL, forkDb);
await resetAndMigrateDatabase(forkUrl);
process.env.DATABASE_URL = forkUrl;

// Keep structured logs out of the repo and quiet during e2e. LoggerModule builds the pino instance
// during AppModule boot even though the e2e harness never calls useLogger, so without this every
// fork would create a `logs/` dir in the repo root and emit verbose boot output. Override by setting
// LOG_DIR / LOG_LEVEL in the shell before `npm run test:e2e`.
process.env.LOG_DIR ??= join(tmpdir(), `soms-test-logs-fork${poolId}`);
process.env.SOMS_DATA_DIR ??= join(tmpdir(), `soms-test-data-fork${poolId}`);
process.env.LOG_LEVEL ??= 'warn';
