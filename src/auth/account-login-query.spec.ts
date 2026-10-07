import { describe, expect, it, vi } from 'vitest';
import { drizzle } from 'drizzle-orm/node-postgres';
import { AdminAuthService } from '../admin/admin-auth.service.js';
import { BusinessCode } from '../common/business-code.js';
import { BruteForceService } from './brute-force.service.js';
import { OtpLoginService } from './otp-login.service.js';

describe('Account login queries', () => {
  it.each(['admin login', 'issue OTP', 'verify OTP'] as const)(
    '%s reads the local account without a duplicate table join',
    async (operation) => {
      // Use the real SQL builder and intercept only the PostgreSQL transport.
      const query = vi.fn(async () => ({ rows: [] }));
      const database = { db: drizzle({ client: { query } as never }) };
      const bruteForce = new BruteForceService();
      const adminAuth = new AdminAuthService(
        database as never,
        {} as never,
        bruteForce,
        {} as never,
        {} as never,
        {} as never,
      );
      const otp = new OtpLoginService(
        database as never,
        {} as never,
        bruteForce,
        {} as never,
      );
      const result =
        operation === 'admin login'
          ? adminAuth.login('ADMIN', 'password')
          : operation === 'issue OTP'
            ? otp.issueCode(7, 42)
            : otp.verifyAndLogin('ADMIN', '123456', {});
      await expect(result).rejects.toMatchObject({
        bizCode:
          operation === 'issue OTP'
            ? BusinessCode.NOT_FOUND
            : operation === 'verify OTP'
              ? BusinessCode.OTP_INVALID
              : BusinessCode.INVALID_CREDENTIALS,
      });
      expect(query).toHaveBeenCalledOnce();
      const [statement, params] = query.mock.calls[0] as unknown as [
        { text: string },
        unknown[],
      ];
      expect(statement.text).toContain('from "Account"');
      expect(statement.text).not.toMatch(/\bjoin\b/i);
      expect(params).toEqual([
        operation === 'issue OTP' ? 42 : 'admin',
        0,
        1,
      ]);
    },
  );
});
