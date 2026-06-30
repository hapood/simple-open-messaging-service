/**
 * 首次种子 admin 账户：node prisma/seed-admin.cjs
 * 读 ADMIN_BOOTSTRAP_PASSWORD 环境变量，argon2 哈希后 upsert username=admin。
 * 仅首次初始化用（update:{} 已存在则不动）；生产应改密或删除本脚本。
 */
require('dotenv').config();
// Prisma 7 生成 .ts（运行时需编译），CJS require 指向 dist（先 npm run build）
const { PrismaClient } = require('../dist/src/prisma/generated/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const argon2 = require('argon2');

(async () => {
  const pwd = process.env.ADMIN_BOOTSTRAP_PASSWORD;
  if (!pwd) {
    console.error('需要 ADMIN_BOOTSTRAP_PASSWORD 环境变量（见 .env）');
    process.exit(1);
  }
  // Prisma 7：driver adapter 必填（与 PrismaService 一致）
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const hash = await argon2.hash(pwd);
    const admin = await prisma.admin.upsert({
      where: { username: 'admin' },
      update: {},
      create: { username: 'admin', hashPwd: hash, enabled: true },
    });
    console.log('admin 已种子: username=admin id=' + admin.id);
  } finally {
    await prisma.$disconnect();
  }
})();
