/**
 * Seed the initial admin account: node prisma/seed-admin.cjs
 * Reads ADMIN_BOOTSTRAP_PASSWORD, argon2-hashes it, and upserts a local User (account=admin) plus a linked
 * Admin profile. First-time init only (update:{} leaves existing rows untouched); in production, change the
 * password or remove this script.
 */
require('dotenv').config();
// Prisma 7 generates .ts (must compile before runtime); the CJS require targets dist (run npm run build first).
const { PrismaClient } = require('../dist/src/prisma/generated/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const argon2 = require('argon2');

(async () => {
  const pwd = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!pwd) {
    console.error('ADMIN_BOOTSTRAP_PASSWORD env var required (see .env)');
    process.exit(1);
  }
  // Prisma 7: a driver adapter is required (matches PrismaService).
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const hash = await argon2.hash(pwd);
    // Identity lives on User (single account namespace); the Admin row is just the linked profile.
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
