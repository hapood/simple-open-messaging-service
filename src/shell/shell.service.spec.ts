import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_CONFIG } from '../config/public-config.js';
import { ShellService } from './shell.service.js';

/**
 * ShellService.compat reports this server's version + the public login policy + the canonical client
 * origins (primaryOrigin from SOMS_DOMAIN, lanOrigin from SOMS_LAN_DOMAIN) for the native shell's
 * symmetric auto-fill: the user enters one domain, the shell fills in the other. compat() is pure (no
 * shell-bundle I/O), so it tests without a fixture. manifest()/bundlePath() hit the filesystem and are
 * covered by the e2e harness instead.
 *
 * Origin derivation (deriveOrigin in src/common/origin.ts) is driven by SOMS_TLS_MODE; these tests set the
 * env per-case because compat() reads process.env at call time (not module load).
 */
describe('ShellService.compat', () => {
  const svc = new ShellService();
  // SERVER_VERSION is read from <cwd>/package.json at module load; compare against the same source so
  // the test tracks the real version rather than hard-coding a literal that drifts on the next bump.
  const pkgVersion = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')).version;

  // Snapshot + restore the env-touching keys so each case is hermetic regardless of the host's .env.
  const envKeys = ['SOMS_DOMAIN', 'SOMS_LAN_DOMAIN', 'SOMS_TLS_MODE'];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => envKeys.forEach((k) => (saved[k] = process.env[k])));
  afterEach(() =>
    envKeys.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }),
  );

  it('reports the server version (the shell decides compatibility, not the server)', () => {
    process.env.SOMS_DOMAIN = 'soms.example.com';
    delete process.env.SOMS_LAN_DOMAIN;
    const r = svc.compat();
    expect(r.serverVersion).toBe(pkgVersion);
  });

  it('folds in the public login policy (registrationOpen + loginMode) from PUBLIC_CONFIG', () => {
    process.env.SOMS_DOMAIN = 'soms.example.com';
    delete process.env.SOMS_LAN_DOMAIN;
    const r = svc.compat();
    expect(r.registrationOpen).toBe(PUBLIC_CONFIG.registrationOpen);
    expect(r.loginMode).toBe(PUBLIC_CONFIG.loginMode);
  });

  it('carries no compatibility-decision fields — the shell owns that decision', () => {
    process.env.SOMS_DOMAIN = 'soms.example.com';
    delete process.env.SOMS_LAN_DOMAIN;
    const r = svc.compat();
    expect(r).not.toHaveProperty('compatible');
    expect(r).not.toHaveProperty('minShellVersion');
  });

  it('derives primaryOrigin from SOMS_DOMAIN + SOMS_TLS_MODE (custom → https :7667)', () => {
    process.env.SOMS_DOMAIN = 'soms.example.com';
    process.env.SOMS_TLS_MODE = 'custom';
    delete process.env.SOMS_LAN_DOMAIN;
    const r = svc.compat();
    expect(r.primaryOrigin).toBe('https://soms.example.com:7667');
    expect(r).not.toHaveProperty('lanOrigin'); // no LAN domain configured
  });

  it('derives primaryOrigin under standard mode (port implicit)', () => {
    process.env.SOMS_DOMAIN = 'soms.example.com';
    process.env.SOMS_TLS_MODE = 'standard';
    delete process.env.SOMS_LAN_DOMAIN;
    expect(svc.compat().primaryOrigin).toBe('https://soms.example.com');
  });

  it('includes lanOrigin only when SOMS_LAN_DOMAIN is set (same backend, derived origin)', () => {
    process.env.SOMS_DOMAIN = 'soms.example.com';
    process.env.SOMS_LAN_DOMAIN = 'soms-lan.example.com';
    process.env.SOMS_TLS_MODE = 'custom';
    const r = svc.compat();
    expect(r.primaryOrigin).toBe('https://soms.example.com:7667');
    expect(r.lanOrigin).toBe('https://soms-lan.example.com:7667');
  });

  it('omits both origins when SOMS_DOMAIN is unset', () => {
    delete process.env.SOMS_DOMAIN;
    delete process.env.SOMS_LAN_DOMAIN;
    const r = svc.compat();
    expect(r).not.toHaveProperty('primaryOrigin');
    expect(r).not.toHaveProperty('lanOrigin');
  });
});
