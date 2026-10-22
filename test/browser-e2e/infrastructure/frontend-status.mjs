import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function artifactDirectory() {
  return process.env.BROWSER_ARTIFACT_DIR || '/tmp/soms-browser-e2e';
}
function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function readFrontendStatus(service) {
  if (!['web', 'admin'].includes(service))
    throw new Error('Unknown frontend service.');
  const directory = join(artifactDirectory(), 'status');
  let sessionId;
  try {
    sessionId = JSON.parse(
      await readFile(join(directory, 'session.json'), 'utf8'),
    ).sessionId;
  } catch {
    throw new Error(
      'Browser E2E requires a current HMR session marker. Inspect the running lab before starting another frontend.',
    );
  }
  let status;
  try {
    status = JSON.parse(
      await readFile(join(directory, `${service}.json`), 'utf8'),
    );
  } catch {
    throw new Error(
      `Missing or invalid ${service} HMR status in ${directory}. Inspect the running lab before starting another frontend.`,
    );
  }
  if (!sessionId || status.sessionId !== sessionId)
    throw new Error(
      `${service} HMR status belongs to session ${String(status.sessionId)}, current session is ${String(sessionId)}.`,
    );
  if (status.service !== service)
    throw new Error(`Invalid ${service} HMR service identity.`);
  return {
    ...status,
    processRunning:
      processIsRunning(status.observerPid) &&
      processIsRunning(status.childPid ?? status.pid),
  };
}
