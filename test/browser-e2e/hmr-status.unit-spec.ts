import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { requireHmrFrontend } from './hmr-status.mjs';

const originalArtifactDir = process.env.BROWSER_ARTIFACT_DIR;

afterEach(() => {
  if (originalArtifactDir === undefined)
    delete process.env.BROWSER_ARTIFACT_DIR;
  else process.env.BROWSER_ARTIFACT_DIR = originalArtifactDir;
});

async function makeStatusRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'soms-hmr-status-'));
  process.env.BROWSER_ARTIFACT_DIR = root;
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSuccessStatuses(
  root: string,
  overrides: Record<string, unknown> = {},
) {
  const statusDirectory = join(root, 'status');
  await mkdir(statusDirectory, { recursive: true });
  const sessionId = 'test-session';
  await writeJson(join(statusDirectory, 'session.json'), {
    sessionId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  });
  for (const service of ['web', 'admin']) {
    await writeJson(join(statusDirectory, `${service}.json`), {
      service,
      state: 'success',
      sessionId,
      buildId: 1,
      observerPid: process.pid,
      childPid: process.pid,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      diagnostics: [],
      ...overrides,
    });
  }
}

describe('requireHmrFrontend', () => {
  it('rejects a missing HMR session marker', async () => {
    await makeStatusRoot();

    await expect(requireHmrFrontend()).rejects.toThrow(
      'current HMR session marker',
    );
  });

  it('accepts matching successful Web and Admin statuses for live processes', async () => {
    const root = await makeStatusRoot();
    await writeSuccessStatuses(root);

    await expect(requireHmrFrontend()).resolves.toMatchObject({
      web: { service: 'web', state: 'success', sessionId: 'test-session' },
      admin: { service: 'admin', state: 'success', sessionId: 'test-session' },
    });
  });

  it('rejects statuses from a different session', async () => {
    const root = await makeStatusRoot();
    await writeSuccessStatuses(root, { sessionId: 'old-session' });

    await expect(requireHmrFrontend()).rejects.toThrow(
      'HMR status belongs to session old-session',
    );
  });

  it('rejects non-success states and stale statuses', async () => {
    const root = await makeStatusRoot();
    await writeSuccessStatuses(root, { state: 'building' });

    await expect(requireHmrFrontend()).rejects.toThrow('HMR is not ready');

    await writeSuccessStatuses(root, { updatedAt: '2000-01-01T00:00:00.000Z' });

    await expect(requireHmrFrontend()).rejects.toThrow('HMR status is stale');
  });

  it('rejects statuses whose observer or child process is gone', async () => {
    const root = await makeStatusRoot();
    await writeSuccessStatuses(root, { childPid: -1 });

    await expect(requireHmrFrontend()).rejects.toThrow(
      'HMR process is not running',
    );
  });
});
