import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Call initialize only after owning the lab ports. Recovery must not overwrite an existing session. */
export function writeHmrSession(directory, sessionId, pid, initialize = false) {
  const marker = join(directory, 'session.json');
  if (!initialize && existsSync(marker)) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `session-${pid}.tmp`);
  writeFileSync(
    temporary,
    `${JSON.stringify({ sessionId, pid, startedAt: sessionId }, null, 2)}\n`,
    { mode: 0o600 },
  );
  renameSync(temporary, marker);
}
