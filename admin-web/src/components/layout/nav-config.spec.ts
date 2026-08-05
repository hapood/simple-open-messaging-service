import { describe, expect, it } from 'vitest';
import { matchNav, NAV_GROUPS } from './nav-config';

/**
 * Guards the sidebar active-state + top-bar breadcrumb logic. These are the paths the IA
 * reorganization produced: 15 primary items, the footer Account item, and the route-driven tab
 * sub-paths (/users/operators, /sessions/admins, /sessions/reuse, /federation/self-check,
 * /push/config, /logs/history, /logs/audit) that must still highlight their parent section.
 */
describe('matchNav', () => {
  it('matches every standalone top-level item exactly', () => {
    expect(matchNav('/dashboard')?.item.key).toBe('dashboard');
    expect(matchNav('/groups')?.item.key).toBe('groups');
    expect(matchNav('/connections')?.item.key).toBe('connections');
    expect(matchNav('/bans')?.item.key).toBe('bans');
    expect(matchNav('/audit')?.item.key).toBe('audit');
    expect(matchNav('/message-reports')?.item.key).toBe('messageReports');
    expect(matchNav('/media')?.item.key).toBe('media');
    expect(matchNav('/settings')?.item.key).toBe('settings');
  });

  it('matches the Users section, its Operators tab, and user detail (prefix)', () => {
    expect(matchNav('/users')?.item.key).toBe('users');
    expect(matchNav('/users/operators')?.item.key).toBe('users');
    expect(matchNav('/users/42')?.item.key).toBe('users');
  });

  it('matches the Sessions hub and its admin/reuse tabs', () => {
    expect(matchNav('/sessions')?.item.key).toBe('sessions');
    expect(matchNav('/sessions/admins')?.item.key).toBe('sessions');
    expect(matchNav('/sessions/reuse')?.item.key).toBe('sessions');
  });

  it('matches Federation, the self-check tab, and peer detail (end:false)', () => {
    expect(matchNav('/federation')?.item.key).toBe('federation');
    expect(matchNav('/federation/self-check')?.item.key).toBe('federation');
    expect(matchNav('/federation/example.com')?.item.key).toBe('federation');
    expect(matchNav('/quotas')).toBeNull();
  });

  it('matches Push + config tab, Logs + history/audit tabs', () => {
    expect(matchNav('/push')?.item.key).toBe('push');
    expect(matchNav('/push/config')?.item.key).toBe('push');
    expect(matchNav('/logs')?.item.key).toBe('logs');
    expect(matchNav('/logs/history')?.item.key).toBe('logs');
    expect(matchNav('/logs/diagnostics')?.item.key).toBe('logs');
  });

  it('resolves each item to its group', () => {
    expect(matchNav('/dashboard')?.group.labelKey).toBe('nav.group.overview');
    expect(matchNav('/sessions')?.group.labelKey).toBe('nav.group.access');
    expect(matchNav('/audit')?.group.labelKey).toBe('nav.group.access');
    expect(matchNav('/message-reports')?.group.labelKey).toBe(
      'nav.group.access',
    );
    expect(matchNav('/settings')?.group.labelKey).toBe('nav.group.system');
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
  it('has exactly 15 primary items + 1 footer item', () => {
    const primary = NAV_GROUPS.filter((g) => !g.footer).flatMap((g) => g.items);
    expect(primary).toHaveLength(15);
    const footer = NAV_GROUPS.filter((g) => g.footer).flatMap((g) => g.items);
    expect(footer.map((i) => i.key)).toEqual(['security']);
  });

  it('no primary group is accidentally marked footer', () => {
    for (const g of NAV_GROUPS.filter((grp) => !grp.footer)) {
      expect(g.footer).toBeFalsy();
    }
  });
});
