import { describe, expect, it } from 'vitest';
import { ShellService } from './shell.service.js';
import { SHELL_COMPAT } from '../config/shell-compat.js';

/**
 * ShellService.compat is the unauthenticated gate the Tauri shell hits at first run / reconfigure
 * (`GET /shell/compat?version=<shell>`). It must (a) accept a shell at/above minShellVersion, (b) reject
 * an older shell with compatible=false + a messageKey the bootstrap surfaces as "upgrade the app", and
 * (c) reject a missing/garbage version. compat() is pure (no data/shell I/O), so it tests without a
 * fixture. manifest()/bundlePath() hit the filesystem and are covered by the e2e harness instead.
 */
describe('ShellService.compat', () => {
  const svc = new ShellService();
  const min = SHELL_COMPAT.minShellVersion;

  it('accepts a shell at exactly minShellVersion', () => {
    expect(svc.compat(min).compatible).toBe(true);
  });
  it('accepts a shell above minShellVersion', () => {
    expect(svc.compat('99.0.0').compatible).toBe(true);
  });
  it('rejects a shell below minShellVersion and surfaces a messageKey', () => {
    const r = svc.compat('0.0.1');
    expect(r.compatible).toBe(false);
    expect(r.minShellVersion).toBe(min);
    // messageKey is null by default (the bootstrap uses its own default copy) — but the field is present.
    expect('messageKey' in r).toBe(true);
  });
  it('rejects a missing / empty version', () => {
    expect(svc.compat(undefined).compatible).toBe(false);
    expect(svc.compat('').compatible).toBe(false);
    expect(svc.compat('   ').compatible).toBe(false);
  });
  it('always echoes the server version + the floor', () => {
    const r = svc.compat('1.2.3');
    expect(r.serverVersion).toMatch(/./); // SERVER_VERSION (may be 'unknown' if package.json unreadable)
    expect(r.minShellVersion).toBe(min);
  });
});
