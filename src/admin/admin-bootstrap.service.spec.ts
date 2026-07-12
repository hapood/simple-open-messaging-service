import { describe, it, expect, vi, afterEach } from 'vitest';
import { AdminBootstrapService } from './admin-bootstrap.service.js';
import { AdminRole } from '../prisma/generated/client.js';

/**
 * AdminBootstrapService self-seeds the first admin on every app start. These specs lock the operational
 * contract that matters:
 *   1. idempotent — an existing admin is a no-op (no second create, no password needed);
 *   2. no password → WARN + continue, never creates and never throws (the chat product stays up);
 *   3. password present → creates User + SUPER_ADMIN profile with an argon2-hashed password;
 *   4. a DB failure during seed is swallowed (logged) so the app still boots.
 * Pure-vitest, hand-rolled Prisma fake — matches the project's spec style (no Nest DI container).
 */
function makeService(opts: { existingUser?: { id: number } | null; findUniqueError?: Error }) {
  const userUpsert = vi.fn(async (args: { create: Record<string, unknown> }) => ({ id: 42, ...args.create }));
  const adminUpsert = vi.fn(async () => ({ id: 7, userId: 42 }));
  const findUnique = opts.findUniqueError
    ? vi.fn(async () => {
        throw opts.findUniqueError;
      })
    : vi.fn(async () => opts.existingUser ?? null);
  const prisma = {
    user: { findUnique, upsert: userUpsert },
    admin: { upsert: adminUpsert },
  };
  const svc = new AdminBootstrapService(prisma as never);
  return { svc, findUnique, userUpsert, adminUpsert };
}

describe('AdminBootstrapService', () => {
  const ORIG = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  afterEach(() => {
    if (ORIG === undefined) delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    else process.env.ADMIN_BOOTSTRAP_PASSWORD = ORIG;
  });

  it('is a no-op when the bootstrap admin already exists (idempotent; no password needed)', async () => {
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    const { svc, userUpsert, adminUpsert } = makeService({ existingUser: { id: 42 } });
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(userUpsert).not.toHaveBeenCalled();
    expect(adminUpsert).not.toHaveBeenCalled();
  });

  it('warns and continues without creating when ADMIN_BOOTSTRAP_PASSWORD is unset', async () => {
    delete process.env.ADMIN_BOOTSTRAP_PASSWORD;
    const { svc, userUpsert, adminUpsert } = makeService({ existingUser: null });
    const warn = vi.spyOn((svc as unknown as { logger: { warn: (m: string) => void } }).logger, 'warn');
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(userUpsert).not.toHaveBeenCalled();
    expect(adminUpsert).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('creates the User + SUPER_ADMIN profile with a hashed password when the password is set', async () => {
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 's3cret-bootstrap-pw';
    const { svc, userUpsert, adminUpsert } = makeService({ existingUser: null });
    await svc.onApplicationBootstrap();

    expect(userUpsert).toHaveBeenCalledTimes(1);
    const userCreate = userUpsert.mock.calls[0][0].create as Record<string, unknown>;
    expect(userCreate.account).toBe('admin');
    expect(userCreate.isForeigner).toBe(false);
    expect(userCreate.hashPwd).not.toBe('s3cret-bootstrap-pw'); // stored hashed, not plaintext
    expect(typeof userCreate.hashPwd).toBe('string');
    expect(userCreate.hashPwd.length).toBeGreaterThan(0);

    expect(adminUpsert).toHaveBeenCalledTimes(1);
    const adminCreate = adminUpsert.mock.calls[0][0].create as Record<string, unknown>;
    expect(adminCreate.role).toBe(AdminRole.SUPER_ADMIN);
    expect(adminCreate.enabled).toBe(true);
  });

  it('swallows a DB failure during seed so the app still boots (logged, does not throw)', async () => {
    process.env.ADMIN_BOOTSTRAP_PASSWORD = 's3cret-bootstrap-pw';
    const { svc } = makeService({ findUniqueError: new Error('connection refused') });
    const error = vi.spyOn((svc as unknown as { logger: { error: (m: string) => void } }).logger, 'error');
    await expect(svc.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalled();
  });
});
