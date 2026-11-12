import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getManagedSecretStatus } from './jwt-secret.js';

describe('managed key status', () => {
  let directory: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'soms-key-status-'));
    vi.stubEnv('SOMS_CONFIG_DIR', directory);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });
  it('returns an expected path for absent keys without creating them', () => {
    expect(getManagedSecretStatus('jwt-admin.key')).toEqual({
      filePath: join(directory, 'jwt-admin.key'),
      configured: false,
      valid: false,
    });
  });
  it('returns metadata and the resolved path, never the secret', () => {
    const secret = 'fixture-secret-material';
    writeFileSync(join(directory, 'jwt-admin.key'), secret, { mode: 0o600 });
    const status = getManagedSecretStatus('jwt-admin.key');
    expect(status).toMatchObject({
      filePath: join(directory, 'jwt-admin.key'),
      configured: true,
      valid: true,
      permissionsSecure: true,
    });
    expect(status.fingerprint).toHaveLength(16);
    expect(JSON.stringify(status)).not.toContain(secret);
  });
});
