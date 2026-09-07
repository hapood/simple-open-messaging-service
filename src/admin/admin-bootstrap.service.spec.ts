import { describe, it, expect, vi, afterEach } from 'vitest';
import { AdminBootstrapService } from './admin-bootstrap.service.js';
import { AdminRole } from '../database/enums.js';
import { PasswordHasher } from '../auth/password-hasher.service.js';
import { account, admin, profileTable as user } from '../database/schema.js';

/**
 * AdminBootstrapService self-seeds the first admin on every app start. These specs lock the operational
 * contract that matters:
 *   1. idempotent — an existing admin is a no-op (no second create, no password needed);
 *   2. no password → WARN + continue, never creates and never throws (the chat product stays up);
 *   3. password present → creates Account + exact Profile + SUPER_ADMIN role with a peppered argon2id-hashed password;
 *   4. a DB failure during seed is swallowed (logged) so the app still boots.
 * Pure-vitest, hand-rolled Drizzle fake (no Nest DI container).
 */
function makeService(opts: {
  existingUser?: { id: number } | null;
  findUniqueError?: Error;
}) {
  const userInsert = vi.fn();
  const accountInsert = vi.fn();
  const adminInsert = vi.fn();
  const findUnique = opts.findUniqueError
    ? vi.fn(async () => {
        throw opts.findUniqueError;
      })
    : vi.fn(async () => opts.existingUser ?? null);
  const database = {
    db: {
      query: { account: { findFirst: findUnique } },
      select: vi.fn(() => {
        const query = {
          from: () => query,
          innerJoin: () => query,
          where: () => query,
          limit: async () => {
            const existing = await findUnique();
            return existing ? [existing] : [];
          },
        };
        return query;
      }),
      insert: vi.fn((table: unknown) => ({
        values:
          table === user
            ? userInsert
            : table === account
              ? accountInsert
              : table === admin
                ? adminInsert
                : vi.fn(),
      })),
    },
  };
  accountInsert.mockImplementation(() => ({
    onConflictDoNothing: vi.fn(() => ({
      returning: vi.fn().mockResolvedValue([{ id: 42 }]),
    })),
  }));
  adminInsert.mockImplementation(() => ({
    onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
  }));
  Object.assign(database.db, {
    transaction: async (fn: (tx: typeof database.db) => unknown) =>
      fn(database.db),
  });
  const svc = new AdminBootstrapService(
    database as never,
    new PasswordHasher(),
  );
  return { svc, findUnique, userInsert, accountInsert, adminInsert };
}

describe('AdminBootstrapService', () => {
  const ORIG = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = ORIG;
  });

  it('is a no-op when the bootstrap admin already exists (idempotent; no password needed)', async () => {
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    const { svc, userInsert, accountInsert, adminInsert } = makeService({
      existingUser: { id: 42 },
    });
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(userInsert).not.toHaveBeenCalled();
    expect(accountInsert).not.toHaveBeenCalled();
    expect(adminInsert).not.toHaveBeenCalled();
  });

  it('warns and continues without creating when ADMIN_BOOTSTRAP_PASSWORD is unset', async () => {
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    const { svc, userInsert, accountInsert, adminInsert } = makeService({
      existingUser: null,
    });
    const warn = vi.spyOn(
      (svc as unknown as { logger: { warn: (m: string) => void } }).logger,
      'warn',
    );
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(userInsert).not.toHaveBeenCalled();
    expect(accountInsert).not.toHaveBeenCalled();
    expect(adminInsert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('creates the Account + exact Profile + SUPER_ADMIN role with a hashed password when the password is set', async () => {
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 's3cret-bootstrap-pw';
    const { svc, userInsert, accountInsert, adminInsert } = makeService({
      existingUser: null,
    });
    await svc.onApplicationBootstrap();

    expect(userInsert).toHaveBeenCalledTimes(1);
    const userCreate = userInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(userCreate.account).toBe('admin');
    expect(userCreate.domain).toBe('local');
    expect(userCreate.namespaceId).toBe(0);

    expect(accountInsert).toHaveBeenCalledTimes(1);
    const accountCreate = accountInsert.mock.calls[0][0] as Record<
      string,
      unknown
    >;
    expect(accountCreate.account).toBe('admin');
    expect(accountCreate.hashPwd).not.toBe('s3cret-bootstrap-pw');
    expect(typeof accountCreate.hashPwd).toBe('string');
    expect((accountCreate.hashPwd as string).length).toBeGreaterThan(0);

    expect(adminInsert).toHaveBeenCalledTimes(1);
    const adminCreate = adminInsert.mock.calls[0][0] as Record<string, unknown>;
    expect(adminCreate.role).toBe(AdminRole.SUPER_ADMIN);
    expect(adminCreate.enabled).toBe(true);
  });

  it('swallows a DB failure during seed so the app still boots (logged, does not throw)', async () => {
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 's3cret-bootstrap-pw';
    const { svc } = makeService({
      findUniqueError: new Error('connection refused'),
    });
    const error = vi.spyOn(
      (svc as unknown as { logger: { error: (m: string) => void } }).logger,
      'error',
    );
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
