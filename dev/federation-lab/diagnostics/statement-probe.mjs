// High-frequency pg_stat_activity sampler: watches one lab database and records
// every statement transition (query_start change) inside transactions, so a
// single transaction's statement-by-statement timeline can be reconstructed.
import pg from 'pg';

const database = process.argv[2] ?? 'soms_fed_lab_bravo';
const intervalMs = Number(process.argv[3] ?? 20);
const durationMs = Number(process.argv[4] ?? 60000);
const outFile = process.argv[5] ?? `/tmp/statements-${database}.jsonl`;

const client = new pg.Client({
  connectionString: 'postgresql://timescale:timescale@localhost:5432/postgres',
  application_name: 'statement-probe',
  statement_timeout: 3000,
  options: '-c default_transaction_read_only=on',
});
await client.connect();

const SQL = `SELECT pid, state, wait_event_type AS wt, wait_event AS we,
  extract(epoch FROM (clock_timestamp() - xact_start)) * 1000 AS xact_ms,
  extract(epoch FROM query_start) * 1000 AS q_start,
  regexp_replace(query, '\\s+', ' ', 'g') AS query
  FROM pg_stat_activity WHERE datname = $1`;

const { createWriteStream } = await import('node:fs');
const out = createWriteStream(outFile);
const seen = new Map(); // pid -> last q_start
const started = Date.now();
let samples = 0;

while (Date.now() - started < durationMs) {
  const tick = Date.now();
  try {
    const { rows } = await client.query(SQL, [database]);
    for (const row of rows) {
      if (!row.q_start) continue; // parked connections have no query_start
      const key = `${row.pid}`;
      const prior = seen.get(key);
      // A new statement on a pid we are tracking (same or new transaction).
      if (prior !== undefined && prior !== row.q_start && row.query !== 'begin') {
        out.write(
          JSON.stringify({
            at: new Date().toISOString(),
            pid: row.pid,
            state: row.state,
            wait: `${row.wt}/${row.we}`,
            xactMs: row.xact_ms ? Number(row.xact_ms) : null,
            query: row.query.slice(0, 220),
          }) + '\n',
        );
      }
      seen.set(key, row.q_start);
    }
    samples += 1;
  } catch (error) {
    console.error(`[probe] ${error.code ?? error.message}`);
  }
  const elapsed = Date.now() - tick;
  if (elapsed < intervalMs)
    await new Promise((resolve) => setTimeout(resolve, intervalMs - elapsed));
}
out.end();
console.log(`[probe] ${samples} samples in ${Date.now() - started}ms -> ${outFile}`);
await client.end();
