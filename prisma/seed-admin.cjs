/**
 * Escape-hatch / local-dev admin seeder: node prisma/seed-admin.cjs
 *
 * In production the app SELF-SEEDS the bootstrap admin on startup (src/admin/admin-bootstrap.service.ts,
 * OnApplicationBootstrap) — this script is NOT needed there. It remains for local dev (run it against your
 * dev DB via dotenv) and as an out-of-band re-seed when you want to force-create the admin without booting
 * the app.
 *
 * Idempotent: if the bootstrap admin (account=admin, domain=local) already exists, exits 0 WITHOUT needing
 * ADMIN_BOOTSTRAP_PASSWORD. Only creating the FIRST admin requires the password; if it is missing then, the
 * script exits non-zero (no placeholder password is ever auto-applied).
 *
 * Reads ADMIN_BOOTSTRAP_PASSWORD, argon2-hashes it, and creates a local User (account=admin) plus a linked
 * Admin profile. Mirrors AdminBootstrapService exactly — keep the two in sync.
 */
require('dotenv').config();
// Prisma 7 generates .ts (must compile before runtime); the CJS require targets dist (run npm run build first).
const { PrismaClient } = require('../dist/src/prisma/generated/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const argon2 = require('argon2');

(async () => {
  // Prisma 7: a driver adapter is required (matches PrismaService).
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    // Skip the moment a bootstrap admin already exists — see file header for why this precedes the password check.
    const existing = await prisma.user.findUnique({
      where: { account_domain: { account: 'admin', domain: 'local' } },
    });
    if (existing) {
      console.log('admin already present (account=admin) — skipping seed');
      return;
    }
    const pwd = process.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!pwd) {
      console.error('ADMIN_BOOTSTRAP_PASSWORD env var required to create the first admin (see .env)');
      // exitCode + return (not process.exit) so the finally below runs prisma.$disconnect().
      process.exitCode = 1;
      return;
    }
    const hash = await argon2.hash(pwd);
    // Identity lives on User (single account namespace); the Admin row is just the linked profile.
    // upsert (update:{}) guards the vanishing race between the findUnique above and the create.
    const user = await prisma.user.upsert({
      where: { account_domain: { account: 'admin', domain: 'local' } },
      update: {},
      create: { account: 'admin', hashPwd: hash, name: 'admin', isForeigner: false, domain: 'local' },
    });
    const admin = await prisma.admin.upsert({
      where: { userId: user.id },
      update: {},
      create: { userId: user.id, enabled: true },
    });
    console.log('admin seeded: account=admin userId=' + user.id + ' adminId=' + admin.id);
  } finally {
    await prisma.$disconnect();
  }
})();
