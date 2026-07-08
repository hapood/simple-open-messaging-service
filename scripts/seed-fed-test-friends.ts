/**
 * Seed two clearly-labeled FEDERATED TEST friends so the consumer FederatedBadge styling can be
 * eyeballed without standing up two live federation servers:
 *
 *   1. alice @ bbb.local  → an APPROVED P2P conversation (appears in the thread list, globe + "bbb.local").
 *   2. carol @ ccc.local  → an INCOMING PENDING friend request (appears in the Pending tab, with a note).
 *
 * Idempotent: upserts by uniqName+domain and the friendship pair, so re-running just refreshes state.
 * Targets the user named by SOMS_SEED_USER (uniqName), defaulting to the first local user; prints whom
 * it seeded for so you know which account to open to see them. Remove with scripts/unseed-fed-test-friends.ts.
 *
 *   npx tsx scripts/seed-fed-test-friends.ts
 *   SOMS_SEED_USER=alice npx tsx scripts/seed-fed-test-friends.ts
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '../src/prisma/generated/client.js';
import { PrismaPg } from '@prisma/adapter-pg';

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

const TEST_DOMAIN_FRIEND = 'bbb.local';
const TEST_DOMAIN_PENDING = 'ccc.local';

async function main() {
  // Resolve "me": the explicit SOMS_SEED_USER uniqName, else the first local non-deleted user.
  let me;
  if (process.env.SOMS_SEED_USER) {
    me = await prisma.user.findUnique({
      where: { uniqName_domain: { uniqName: process.env.SOMS_SEED_USER, domain: 'local' } },
    });
    if (!me || me.isForeigner) throw new Error(`SOMS_SEED_USER=${process.env.SOMS_SEED_USER} is not a local user`);
  } else {
    me = await prisma.user.findFirst({ where: { domain: 'local', isForeigner: false, isDeleted: false }, orderBy: { id: 'asc' } });
  }
  if (!me) throw new Error('no local user found — register one first, or set SOMS_SEED_USER');

  // ── 1. APPROVED federated friend (alice @ bbb.local) → thread list ──────────────────────────
  const alice = await prisma.user.upsert({
    where: { uniqName_domain: { uniqName: 'alice', domain: TEST_DOMAIN_FRIEND } },
    create: {
      uniqName: 'alice',
      domain: TEST_DOMAIN_FRIEND,
      isForeigner: true,
      hashPwd: cryptoRandom(),
      name: 'Alice',
      avatar: '',
      bio: 'federated test friend',
    },
    update: { isForeigner: true, name: 'Alice', isDeleted: false },
  });

  // Find or create the P2P thread + both participants.
  const [aId, bId] = me.id < alice.id ? [me.id, alice.id] : [alice.id, me.id];
  let friendship = await prisma.friendship.findUnique({ where: { userAId_userBId: { userAId: aId, userBId: bId } } });
  let threadId = friendship?.threadId ?? null;
  if (!threadId) {
    const thread = await prisma.messageThread.create({ data: { type: 'P2P' } });
    threadId = thread.id;
    await prisma.threadParticipant.createMany({
      data: [
        { userId: me.id, threadId, role: null },
        { userId: alice.id, threadId, role: null },
      ],
    });
  }
  await prisma.friendship.upsert({
    where: { userAId_userBId: { userAId: aId, userBId: bId } },
    create: { userAId: aId, userBId: bId, requesterId: alice.id, status: 'APPROVED', threadId },
    update: { status: 'APPROVED', threadId },
  });

  // ── 2. PENDING federated friend (carol @ ccc.local) → Pending tab (carol is the requester) ──
  const carol = await prisma.user.upsert({
    where: { uniqName_domain: { uniqName: 'carol', domain: TEST_DOMAIN_PENDING } },
    create: {
      uniqName: 'carol',
      domain: TEST_DOMAIN_PENDING,
      isForeigner: true,
      hashPwd: cryptoRandom(),
      name: 'Carol',
      avatar: '',
      bio: 'federated test requester',
    },
    update: { isForeigner: true, name: 'Carol', isDeleted: false },
  });
  const [cA, cB] = me.id < carol.id ? [me.id, carol.id] : [carol.id, me.id];
  await prisma.friendship.upsert({
    where: { userAId_userBId: { userAId: cA, userBId: cB } },
    create: {
      userAId: cA,
      userBId: cB,
      requesterId: carol.id,
      status: 'PENDING',
      reqMessage: 'Hi! Federated test request — ignore/remove me',
    },
    update: { status: 'PENDING', requesterId: carol.id, reqMessage: 'Hi! Federated test request — ignore/remove me' },
  });

  console.log(`\nSeeded federated test friends for: ${me.uniqName} (id=${me.id}, domain=local).`);
  console.log('  • thread list : alice @ bbb.local  (APPROVED P2P)');
  console.log('  • pending tab : carol @ ccc.local  (incoming PENDING request)');
  console.log('Log in as that user to see the globe + domain badges. Remove with:');
  console.log('  npx tsx scripts/unseed-fed-test-friends.ts\n');
}

function cryptoRandom(): string {
  return randomUUID(); // unusable — foreign stubs never log in
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
