import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS, collectAuditData } from './audit-actions.js';
import en from '../../admin-web/src/locales/en/audit.json';
import zh from '../../admin-web/src/locales/zh-CN/audit.json';

describe('audit action registry', () => {
  it('provides both display languages for every registered action', () => {
    expect(Object.keys(en.actions).sort()).toEqual(
      Object.keys(AUDIT_ACTIONS).sort(),
    );
    expect(Object.keys(zh.actions).sort()).toEqual(
      Object.keys(AUDIT_ACTIONS).sort(),
    );
    expect(
      Object.keys(AUDIT_ACTIONS).every((action) => action.length <= 64),
    ).toBe(true);
  });

  it('records only allowlisted user fields, never credentials', () => {
    expect(
      collectAuditData('user.create', {
        account: 'alice',
        password: 'secret',
        token: 'secret',
      }),
    ).toEqual({ account: 'alice' });
    for (const action of [
      'admin.change_password',
      'admin.2fa_enable',
      'admin.2fa_disable',
      'admin.2fa_regenerate_backup',
      'admin.webauthn_register_finish',
      'user.issue_login_code',
      'user.generate_initial_password',
    ] as const) {
      expect(
        collectAuditData(action, {
          password: 'secret',
          code: '123456',
          pendingToken: 'secret',
          registrationResponse: {},
        }),
      ).toEqual({});
    }
  });

  it('does not recursively capture unvalidated objects under safe field names', () => {
    expect(
      collectAuditData('user.create', { account: { password: 'secret' } }),
    ).toEqual({});
    expect(
      collectAuditData('user.batch', {
        ids: [{ token: 'secret' }],
        action: 'disable',
      }),
    ).toEqual({ action: 'disable' });
  });

  it('preserves reset values and copies batch IDs', () => {
    expect(
      collectAuditData('user.quota.set', {
        dailyMsgLimit: 0,
        maxFileBytes: null,
        password: 'secret',
      }),
    ).toEqual({ dailyMsgLimit: 0, maxFileBytes: null });
    const ids = [1, 2];
    const data = collectAuditData('user.batch', { ids, action: 'disable' });
    ids.push(3);
    expect(data).toEqual({ ids: [1, 2], action: 'disable' });
  });

  it('projects nested rate-limit configuration without leaking extra fields', () => {
    expect(
      collectAuditData('settings.rate-limits.save', [
        {
          policy: 'auth.password.login',
          mode: 'enforce',
          token: 'secret',
          buckets: [
            {
              name: 'account',
              ratePerSecond: 1,
              burst: 5,
              enforce: false,
              password: 'secret',
            },
          ],
        },
      ]),
    ).toEqual({
      policies: [
        {
          policy: 'auth.password.login',
          mode: 'enforce',
          buckets: [
            { name: 'account', ratePerSecond: 1, burst: 5, enforce: false },
          ],
        },
      ],
    });
    expect(
      collectAuditData('settings.rate-limits.fixed-window.save', [
        {
          policy: 'admin.login',
          limit: 5,
          windowSeconds: 60,
          password: 'secret',
        },
      ]),
    ).toEqual({
      policies: [{ policy: 'admin.login', limit: 5, windowSeconds: 60 }],
    });
  });
});
