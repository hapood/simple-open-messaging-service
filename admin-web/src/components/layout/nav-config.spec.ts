import { describe, expect, it } from 'vitest';
import { matchNav, NAV_GROUPS } from './nav-config';

/**
 * Guards the sidebar active-state + top-bar breadcrumb logic. Disabled first-release entries stay
 * visible in the sidebar but must not become active or provide a breadcrumb.
 */
describe('matchNav', () => {
  it('matches every enabled standalone top-level item exactly', () => {
    expect(matchNav('/message-reports')?.item.key).toBe('messageReports');
  });

  it('matches the Users section, its Operators tab, and user detail (prefix)', () => {
    expect(matchNav('/users')?.item.key).toBe('users');
    expect(matchNav('/users/operators')?.item.key).toBe('users');
    expect(matchNav('/users/42')?.item.key).toBe('users');
  });

  it('matches the enabled Logs hub and its child routes', () => {
    expect(matchNav('/logs')?.item.key).toBe('logs');
    expect(matchNav('/logs/history')?.item.key).toBe('logs');
    expect(matchNav('/logs/diagnostics')?.item.key).toBe('logs');
  });

  it('resolves enabled items to their groups', () => {
    expect(matchNav('/users')?.group.labelKey).toBe('nav.group.overview');
    expect(matchNav('/message-reports')?.group.labelKey).toBe(
      'nav.group.access',
    );
    expect(matchNav('/logs')?.group.labelKey).toBe('nav.group.system');
  });

  it('matches the Federation hub and its child routes (prefix)', () => {
    expect(matchNav('/federation')?.item.key).toBe('federation');
    expect(matchNav('/federation/self-check')?.item.key).toBe('federation');
    expect(matchNav('/federation/example.com')?.item.key).toBe('federation');
    expect(matchNav('/federation')?.group.labelKey).toBe('nav.group.overview');
  });

  it('does not match disabled first-release entries or their child routes', () => {
    for (const path of [
      '/dashboard',
      '/groups',
      '/connections',
      '/bans',
      '/durable-tasks',
      '/sessions/admins',
      '/push/config',
      '/media',
      '/rate-limits',
      '/settings',
    ]) {
      expect(matchNav(path)).toBeNull();
    }
  });

  it('matches My Account in the footer Account group', () => {
    const m = matchNav('/security');
    expect(m?.item.key).toBe('security');
    expect(m?.group.labelKey).toBe('nav.group.account');
    expect(m?.group.footer).toBe(true);
  });

  it('returns null for an unknown path', () => {
    expect(matchNav('/does-not-exist')).toBeNull();
  });
});

describe('NAV_GROUPS shape', () => {
  it('has exactly 14 primary items and both account pages in the footer', () => {
    const primary = NAV_GROUPS.filter((g) => !g.footer).flatMap((g) => g.items);
    expect(primary).toHaveLength(14);
    const footer = NAV_GROUPS.filter((g) => g.footer).flatMap((g) => g.items);
    expect(footer.map((i) => i.key)).toEqual(['security', 'adminSessions']);
  });

  it('only enables the first-release navigation surface', () => {
    const enabled = NAV_GROUPS.flatMap((group) => group.items)
      .filter((item) => !item.disabled)
      .map((item) => item.key);
    expect(enabled).toEqual([
      'users',
      'federation',
      'messageReports',
      'logs',
      'security',
      'adminSessions',
    ]);
  });

  it('no primary group is accidentally marked footer', () => {
    for (const g of NAV_GROUPS.filter((grp) => !grp.footer)) {
      expect(g.footer).toBeFalsy();
    }
  });
});
