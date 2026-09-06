import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { connectP2pAuditDatabases, closeP2pAuditDatabases } from './audit.mjs';
import {
  readFederationAuditSnapshot,
  compareFederationSnapshot,
} from './final-audit.mjs';

// Read-only diagnostic for an interrupted run. It does not claim completed workload coverage
// and does not trigger lazy profile materialization through client APIs.
async function main() {
  if (process.argv.length !== 3)
    throw new Error('usage: node audit-run.mjs <operations.json>');
  const log = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const connections = await connectP2pAuditDatabases(process.env.DATABASE_URL);
  try {
    const snapshot = await readFederationAuditSnapshot(connections, log);
    const result = compareFederationSnapshot({
      log,
      ...snapshot,
      enforceCoverage: false,
      validateProfiles: false,
    });
    console.log(
      JSON.stringify(
        {
          mode: 'READ_ONLY_DIAGNOSTIC',
          passed: result.passed,
          failures: result.failures,
          messageSets: result.messageSets,
        },
        null,
        2,
      ),
    );
    if (!result.passed) process.exitCode = 1;
  } finally {
    await closeP2pAuditDatabases(connections);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
