import type { Pool } from 'pg';

const DRAIN_POLL_MS = 25;
const DRAIN_TIMEOUT_MS = 15_000;
const LOCK_TIMEOUT_SQL = "SET LOCAL lock_timeout = '2s'";
const RETRYABLE_CODES = new Set([
  '40P01', // deadlock_detected
  '55P03', // lock_not_available
]);
const RETRY_BACKOFF_MS = 150;
const MAX_ATTEMPTS = 4;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Truncate core tables between tests without racing this app's own durable
 * scheduler. A still-running background task holds AccessShare on the tables a
 * TRUNCATE needs AccessExclusive for, and the task's next statement can want a
 * lock the TRUNCATE already took — PostgreSQL resolves that pairing as a
 * deadlock and kills one side mid-test. Drain PROCESSING tasks first, then run
 * the statement under a short lock timeout with retry so a task claimed in the
 * drain window back instead of wedging the hook. */
export async function truncateTablesForTest(
  pool: Pool,
  statement: string,
): Promise<void> {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  for (;;) {
    const { rows } = await pool.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM \"DurableTask\" WHERE status = 'PROCESSING'",
    );
    if ((rows[0]?.c ?? 0) === 0 || Date.now() > deadline) break;
    await sleep(DRAIN_POLL_MS);
  }
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await pool.query(`BEGIN; ${LOCK_TIMEOUT_SQL}; ${statement}; COMMIT`);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: string }).code;
      if (!RETRYABLE_CODES.has(code ?? '') || attempt === MAX_ATTEMPTS)
        throw error;
      await pool.query('ROLLBACK').catch(() => undefined);
      await sleep(RETRY_BACKOFF_MS);
    }
  }
  throw lastError;
}
