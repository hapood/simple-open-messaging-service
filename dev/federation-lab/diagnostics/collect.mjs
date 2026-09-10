import 'dotenv/config';
import { mkdir, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const directory = process.env.SOMS_DIAGNOSTICS_DIR;
if (!directory) throw new Error('SOMS_DIAGNOSTICS_DIR is required');
await mkdir(directory, { recursive: true });
const output = createWriteStream(
  join(directory, `database-${process.pid}.jsonl`),
);
output.on('error', (error) => {
  console.error(`[diagnostics] output failed: ${error.code}`);
  process.exitCode = 1;
  stopping = true;
});
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  application_name: 'lab-diagnostics',
  connectionTimeoutMillis: 5000,
  statement_timeout: 2000,
  options: '-c default_transaction_read_only=on',
});
let stopping = false;
process.on('SIGINT', () => {
  stopping = true;
});
process.on('SIGTERM', () => {
  stopping = true;
});
await client.connect();
console.log(
  `[diagnostics] collecting into ${directory}; Ctrl+C stops collection`,
);
try {
  while (!stopping) {
    const start = Date.now();
    try {
      const { rows } =
        // Keep SQL beside its backend PID so lock waiters and the last statement
        // of an idle transaction can be identified from the same sample.
        await client.query(`SELECT datname, pid, state, wait_event_type, wait_event, query,
        extract(epoch FROM (clock_timestamp() - xact_start)) * 1000 AS transaction_ms,
        extract(epoch FROM (clock_timestamp() - query_start)) * 1000 AS query_ms,
        pg_blocking_pids(pid) AS blockers
        FROM pg_stat_activity WHERE datname IN ('soms_fed_lab_alpha','soms_fed_lab_bravo','soms_fed_lab_charlie')`);
      const pressure = Object.fromEntries(
        await Promise.all(
          ['cpu', 'io', 'memory'].map(async (kind) => [
            kind,
            await readFile(`/proc/pressure/${kind}`, 'utf8').catch(() => null),
          ]),
        ),
      );
      if (output.writableLength < 1024 * 1024)
        output.write(
          JSON.stringify({
            time: new Date().toISOString(),
            sampleMs: Date.now() - start,
            sessions: rows,
            pressure,
          }) + '\n',
        );
    } catch (error) {
      console.error(`[diagnostics] sample failed: ${error.code ?? error.name}`);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, 1000 - (Date.now() - start))),
    );
  }
} finally {
  await client.end();
  output.end();
}
