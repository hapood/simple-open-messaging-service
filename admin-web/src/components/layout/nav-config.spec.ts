import { describe, expect, it } from 'vitest';
import { matchNav, NAV_GROUPS } from './nav-config';

/**
 * Guards the sidebar active-state and top-bar breadcrumb logic for every navigation entry.
 */
describe('matchNav', () => {
  it('matches every enabled standalone top-level item exactly', () => {
    expect(matchNav('/message-reports')?.item.key).toBe('messageReports');
  });

  it('matches the Users roster and user detail (prefix)', () => {
    expect(matchNav('/users')?.item.key).toBe('users');
    expect(matchNav('/users/42')?.item.key).toBe('users');
  });

  it('matches the enabled Logs hub and its child routes', () => {
    expect(matchNav('/logs')?.item.key).toBe('logs');
    expect(matchNav('/logs/history')?.item.key).toBe('logs');
    expect(matchNav('/logs/diagnostics')?.item.key).toBe('logs');
  });

  it('resolves enabled items to their groups', () => {
    expect(matchNav('/users')?.group.labelKey).toBe('nav.group.users');
    expect(matchNav('/message-reports')?.group.labelKey).toBe(
      'nav.group.users',
    );
    expect(matchNav('/logs')?.group.labelKey).toBe('nav.group.monitoring');
  });

  it('matches the Federation hub and peer detail (prefix)', () => {
    expect(matchNav('/federation')?.item.key).toBe('federation');
    expect(matchNav('/federation/example.com')?.item.key).toBe('federation');
    expect(matchNav('/federation')?.group.labelKey).toBe('nav.group.network');
  });

  it('enables network, local information, quota, and settings without a legacy network entry', () => {
    expect(matchNav('/network')?.item.key).toBe('networkInfo');
    expect(matchNav('/local-information')?.item.key).toBe('localInformation');
    expect(matchNav('/quota/defaults')?.item.key).toBe('quota');
    expect(matchNav('/settings')?.item.key).toBe('settings');
    expect(matchNav('/network-info')).toBeNull();
  });

  it('matches all previously disabled entries and their child routes', () => {
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
    ]) {
      expect(matchNav(path)).not.toBeNull();
    }
  });

  it('keeps My Account in the footer and both login session tabs in Security', () => {
    const m = matchNav('/security');
    expect(m?.item.key).toBe('security');
    expect(m?.group.labelKey).toBe('nav.group.account');
    expect(m?.group.footer).toBe(true);
    expect(matchNav('/sessions/admins')?.group.labelKey).toBe(
      'nav.group.security',
    );
    expect(matchNav('/sessions/admins')?.item.key).toBe('sessions');
    expect(matchNav('/admin-sessions')).toBeNull();
  });

  it('returns null for an unknown path', () => {
    expect(matchNav('/does-not-exist')).toBeNull();
  });
});

describe('NAV_GROUPS shape', () => {
  it('keeps Dashboard standalone above the named groups', () => {
    expect(NAV_GROUPS[0].labelKey).toBeUndefined();
    expect(NAV_GROUPS[0].items.map((item) => item.key)).toEqual(['dashboard']);
    expect(matchNav('/dashboard/unknown')).toBeNull();
  });
  it('has exactly 17 primary items and only My Account in the footer', () => {
    const primary = NAV_GROUPS.filter((g) => !g.footer).flatMap((g) => g.items);
    expect(primary).toHaveLength(17);
    const footer = NAV_GROUPS.filter((g) => g.footer).flatMap((g) => g.items);
    expect(footer.map((i) => i.key)).toEqual(['security']);
  });

  it('enables every navigation entry and matches its destination', () => {
    for (const group of NAV_GROUPS) {
      for (const item of group.items) {
        expect(matchNav(item.to)).toEqual({ item, group });
      }
    }
  });

  it('no primary group is accidentally marked footer', () => {
    for (const g of NAV_GROUPS.filter((grp) => !grp.footer)) {
      expect(g.footer).toBeFalsy();
    }
  });
});
