/**
 * Remove the federated TEST friends seeded by seed-fed-test-friends.ts (alice @ bbb.local,
 * carol @ ccc.local) and their threads/invites. Idempotent. Safe — it targets only those two
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
  const stubs = await prisma.user.findMany({
    where: { domain: { in: TEST_DOMAINS }, account: { in: ['alice', 'carol'] } },
    select: { id: true },
  });
  const stubIds = stubs.map((s) => s.id);

  // Invites sent by / addressed to these stubs — must go FIRST: Invite→User is a restricted FK, and a
  // GROUP invite may also reference a thread. Delete them before threads and stubs.
  if (stubIds.length) {
    await prisma.invite.deleteMany({
      where: { OR: [{ fromUserId: { in: stubIds } }, { toUserId: { in: stubIds } }] },
    });
  }

  // The P2P threads owned by these test stubs (via their participants) — delete those threads.
  const threadIds = stubIds.length
    ? (
        await prisma.threadParticipant.findMany({
          where: { userId: { in: stubIds } },
          select: { threadId: true },
          distinct: ['threadId'],
        })
      ).map((p) => p.threadId)
    : [];
  if (threadIds.length) await prisma.messageThread.deleteMany({ where: { id: { in: threadIds } } });

  // The stubs themselves.
  const deleted = await prisma.user.deleteMany({
    where: { domain: { in: TEST_DOMAINS }, account: { in: ['alice', 'carol'] } },
  });
  console.log(`\nRemoved ${deleted.count} federated test stub(s) (+ their threads/invites).\n`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
