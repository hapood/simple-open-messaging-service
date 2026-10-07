import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PUBLIC_CONFIG } from '../config/public-config.js';
import { ClientCompatService } from './client-compat.service.js';
import type { SettingsService } from '../settings/settings.service.js';

/**
 * ClientCompatService.compat reports the client API version, server version, login policy and canonical
 * client origins. Its output does not depend on any on-disk web bundle.
 *
 * Origin derivation (deriveOrigin in src/common/origin.ts) is driven by SOMS_TLS_MODE and the injected,
 * database-backed identity domain; tests set only the transport/display environment values per case.
 */
describe('ClientCompatService.compat', () => {
  // SettingsService is @Global in the app; pass a stub whose getFirebaseConfig() returns null so the folded
  // firebaseConfig is {configured:false} without dragging in the real service + its database dep.
  let identityDomain = 'soms.example.com';
  const svc = new ClientCompatService({
    getFirebaseConfig: () => null,
    get somsDomain() {
      return identityDomain;
    },
  } as unknown as SettingsService);
  // SERVER_VERSION is read from <cwd>/package.json at module load; compare against the same source so
  // the test tracks the real version rather than hard-coding a literal that drifts on the next bump.
  const pkgVersion = JSON.parse(
    readFileSync(resolve(process.cwd(), 'package.json'), 'utf8'),
  ).version;

  // Snapshot + restore the env-touching keys so each case is hermetic regardless of the host's .env.
  const envKeys = [
    'SOMS_DOMAIN',
    'SOMS_WEB_DOMAIN',
    'SOMS_LAN_DOMAIN',
    'SOMS_TLS_MODE',
  ];
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    identityDomain = 'soms.example.com';
    envKeys.forEach((k) => (saved[k] = process.env[k]));
  });
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
    expect(r.apiVersion).toBe(1);
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
  });

  it('derives primaryOrigin from SOMS_DOMAIN + SOMS_TLS_MODE (single-port → https :7667)', () => {
    process.env.SOMS_DOMAIN = 'soms.example.com';
    process.env.SOMS_TLS_MODE = 'single-port';
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

  it('uses SOMS_WEB_DOMAIN for primaryOrigin without changing the identity domain', () => {
    identityDomain = 'example.com';
    process.env.SOMS_WEB_DOMAIN = 'soms.example.com';
    process.env.SOMS_TLS_MODE = 'single-port';
    expect(svc.compat().primaryOrigin).toBe('https://soms.example.com:7667');
  });

  it('includes lanOrigin only when SOMS_LAN_DOMAIN is set (same backend, derived origin)', () => {
    process.env.SOMS_DOMAIN = 'soms.example.com';
    process.env.SOMS_LAN_DOMAIN = 'soms-lan.example.com';
    process.env.SOMS_TLS_MODE = 'single-port';
    const r = svc.compat();
    expect(r.primaryOrigin).toBe('https://soms.example.com:7667');
    expect(r.lanOrigin).toBe('https://soms-lan.example.com:7667');
  });

  it('omits both origins when SOMS_DOMAIN is unset', () => {
    identityDomain = '';
    delete process.env.SOMS_LAN_DOMAIN;
    const r = svc.compat();
    expect(r).not.toHaveProperty('primaryOrigin');
    expect(r).not.toHaveProperty('lanOrigin');
  });
});
