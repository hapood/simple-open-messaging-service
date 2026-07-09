/**
 * Remove the federated TEST friends seeded by seed-fed-test-friends.ts (alice @ bbb.local,
 * carol @ ccc.local) and their threads/friendships. Idempotent. Safe — it targets only those two
 * test domains, never real federation stubs.
 *
 *   npx tsx scripts/unseed-fed-test-friends.ts
 */
import 'dotenv/config';
import { PrismaClient } from '../src/prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

const TEST_DOMAINS = ['bbb.local', 'ccc.local'];

async function main() {
  // The P2P threads owned by these test stubs (via their participants) — delete those threads.
  const stubs = await prisma.user.findMany({
    where: { domain: { in: TEST_DOMAINS }, account: { in: ['alice', 'carol'] } },
    select: { id: true },
  });
  const threadIds = stubs.length
    ? (
        await prisma.threadParticipant.findMany({
          where: { userId: { in: stubs.map((s) => s.id) } },
          select: { threadId: true },
          distinct: ['threadId'],
        })
      ).map((p) => p.threadId)
    : [];
  if (threadIds.length) await prisma.messageThread.deleteMany({ where: { id: { in: threadIds } } });

  // Friendships involving the stubs — User CASCADE handles the rows when the stubs are deleted below,
  // but delete explicitly first so the order is obvious and survives any FK tweak.
  if (stubs.length) {
    await prisma.friendship.deleteMany({
      where: { OR: [{ userAId: { in: stubs.map((s) => s.id) } }, { userBId: { in: stubs.map((s) => s.id) } }] },
    });
  }
  // The stubs themselves.
  const deleted = await prisma.user.deleteMany({
    where: { domain: { in: TEST_DOMAINS }, account: { in: ['alice', 'carol'] } },
  });
  console.log(`\nRemoved ${deleted.count} federated test stub(s) (+ their threads/friendships).\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
