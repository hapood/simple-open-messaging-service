import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SERVICES = ['web', 'admin'];

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function requireHmrFrontend(options = {}) {
  const artifactDirectory =
    process.env.BROWSER_ARTIFACT_DIR || '/tmp/soms-browser-e2e';
  const maximumAgeMs = options.maximumAgeMs ?? 24 * 60 * 60 * 1000;
  const statuses = {};
  let sessionId;
  try {
    sessionId = JSON.parse(
      await readFile(join(artifactDirectory, 'status', 'session.json'), 'utf8'),
    ).sessionId;
  } catch (error) {
    throw new Error(
      `Browser E2E requires a current HMR session marker. Check whether dev:fe is already running before starting another frontend: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  for (const service of SERVICES) {
    const path = join(artifactDirectory, 'status', `${service}.json`);
    let status;
    try {
      status = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      throw new Error(
        `Browser E2E requires a current HMR build status. Check whether dev:fe is already running before starting another frontend. Missing or invalid ${service} HMR status at ${path}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!sessionId || status.sessionId !== sessionId) {
      throw new Error(
        `${service} HMR status belongs to session ${String(status.sessionId)}, current session is ${String(sessionId)}.`,
      );
    }
    if (status.service !== service || status.state !== 'success') {
      throw new Error(
        `${service} HMR is not ready: state=${String(status.state)}, buildId=${String(status.buildId)}, diagnostics=${JSON.stringify(status.diagnostics ?? [])}`,
      );
    }
    if (
      !processIsRunning(status.observerPid) ||
      !processIsRunning(status.childPid ?? status.pid)
    ) {
      throw new Error(
        `${service} HMR process is not running: observer=${String(status.observerPid)}, child=${String(status.childPid ?? status.pid)}.`,
      );
    }
    const updatedAt = Date.parse(status.updatedAt);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maximumAgeMs) {
      throw new Error(
        `${service} HMR status is stale: ${String(status.updatedAt)}.`,
      );
    }
    statuses[service] = status;
  }

  return statuses;
}
