import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_CONFIG } from '../config/public-config.js';
import { ShellService } from './shell.service.js';

/**
 * ShellService.compat reports this server's version + the public login policy (`GET /shell/compat`).
 * Compatibility is decided by the shell — it carries a hard-coded backend-version upper bound
 * (`COMPAT_BACKEND_MAX` in the shell's Cargo source) and accepts this server iff
 * `serverVersion < COMPAT_BACKEND_MAX`. The server sets no shell floor, so compat() carries no compat
 * logic: it echoes SERVER_VERSION AND folds in PUBLIC_CONFIG (registrationOpen + loginMode) so the
 * Tauri shell learns the enabled login methods in the SAME round-trip (mirrors GET /api/v1/config; the
 * browser build keeps using /config). compat() is pure (no shell-bundle I/O), so it tests without a
 * fixture. manifest()/bundlePath() hit the filesystem and are covered by the e2e harness instead.
 */
describe('ShellService.compat', () => {
  const svc = new ShellService();
  // SERVER_VERSION is read from <cwd>/package.json at module load; compare against the same source so
  // the test tracks the real version rather than hard-coding a literal that drifts on the next bump.
  const pkgVersion = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version;

  it('reports the server version (the shell decides compatibility, not the server)', () => {
    const r = svc.compat();
    expect(r.serverVersion).toBe(pkgVersion);
  });

  it('folds in the public login policy (registrationOpen + loginMode) from PUBLIC_CONFIG', () => {
    const r = svc.compat();
    expect(r.registrationOpen).toBe(PUBLIC_CONFIG.registrationOpen);
    expect(r.loginMode).toBe(PUBLIC_CONFIG.loginMode);
  });

  it('carries no compatibility-decision fields — the shell owns that decision', () => {
    const r = svc.compat();
    expect(Object.keys(r).sort()).toEqual(['loginMode', 'registrationOpen', 'serverVersion']);
    expect(r).not.toHaveProperty('compatible');
    expect(r).not.toHaveProperty('minShellVersion');
  });
});
