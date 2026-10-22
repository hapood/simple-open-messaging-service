import { readFrontendStatus } from './infrastructure/frontend-status.mjs';

export async function requireHmrFrontend(options = {}) {
  const maximumAgeMs = options.maximumAgeMs ?? 24 * 60 * 60 * 1000;
  const statuses = {};
  for (const service of ['web', 'admin']) {
    const status = await readFrontendStatus(service);
    if (status.state !== 'success')
      throw new Error(
        `${service} HMR is not ready: state=${String(status.state)}, buildId=${String(status.buildId)}, diagnostics=${JSON.stringify(status.diagnostics ?? [])}`,
      );
    if (!status.processRunning)
      throw new Error(
        `${service} HMR process is not running: observer=${String(status.observerPid)}, child=${String(status.childPid ?? status.pid)}.`,
      );
    const updatedAt = Date.parse(status.updatedAt);
    if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maximumAgeMs)
      throw new Error(
        `${service} HMR status is stale: ${String(status.updatedAt)}.`,
      );
    statuses[service] = status;
  }
  return statuses;
}
