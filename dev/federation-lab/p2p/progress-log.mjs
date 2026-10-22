import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/** Persist each progress event before printing it, including on a failing run. */
export function createProgressLogger(runDir, output = console) {
  const path = join(runDir, 'progress.jsonl');
  const write = (level, message) => {
    // Progress callbacks are synchronous. Small synchronous appends preserve order
    // and avoid losing queued writes when the runner exits after an error.
    appendFileSync(
      path,
      `${JSON.stringify({ recordedAt: new Date().toISOString(), level, message })}\n`,
      { mode: 0o600 },
    );
    output[level === 'error' ? 'error' : 'log'](message);
  };
  return {
    info: (message) => write('info', message),
    error: (message) => write('error', message),
  };
}
