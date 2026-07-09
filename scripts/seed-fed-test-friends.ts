/**
 * Seed two clearly-labeled FEDERATED TEST friends so the consumer FederatedBadge styling can be
 * eyeballed without standing up two live federation servers:
 *
 *   1. alice @ bbb.local  → an APPROVED P2P conversation (appears in the thread list, globe + "bbb.local").
 *   2. carol @ ccc.local  → an INCOMING PENDING friend invite (appears in the Pending tab, with a note).
 *
 * Idempotent: upserts by account+domain, reuses the P2P thread if present, and keys the pending invite
 * on a fixed (origin, originId) so re-running just refreshes state. Targets the user named by
 * SOMS_SEED_USER (account), defaulting to the first local user; prints whom it seeded for so you know
 * which account to open to see them. Remove with scripts/unseed-fed-test-friends.ts.
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
/** Friend/group invite TTL (mirrors InviteService). */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function main() {
  // Resolve "me": the explicit SOMS_SEED_USER account, else the first local non-deleted user.
  let me;
  if (process.env.SOMS_SEED_USER) {
    me = await prisma.user.findUnique({
      where: { account_domain: { account: process.env.SOMS_SEED_USER, domain: 'local' } },
    });
    if (!me || me.isForeigner) throw new Error(`SOMS_SEED_USER=${process.env.SOMS_SEED_USER} is not a local user`);
  } else {
    me = await prisma.user.findFirst({ where: { domain: 'local', isForeigner: false, isDeleted: false }, orderBy: { id: 'asc' } });
  }
  if (!me) throw new Error('no local user found — register one first, or set SOMS_SEED_USER');

  // ── 1. APPROVED federated friend (alice @ bbb.local) → thread list ──────────────────────────
  // An approved friend == an active P2P thread with both users as participants (the Friendship table
  // is gone). Find-or-create that thread.
  const alice = await prisma.user.upsert({
    where: { account_domain: { account: 'alice', domain: TEST_DOMAIN_FRIEND } },
    create: {
      account: 'alice',
      domain: TEST_DOMAIN_FRIEND,
      isForeigner: true,
      hashPwd: cryptoRandom(),
      name: 'Alice',
      avatar: '',
      bio: 'federated test friend',
    },
    update: { isForeigner: true, name: 'Alice', isDeleted: false },
  });

  let threadId: number | null = await findP2PThreadBetween(me.id, alice.id);
  if (threadId === null) {
    const thread = await prisma.messageThread.create({ data: { type: 'P2P' } });
    threadId = thread.id;
    await prisma.threadParticipant.createMany({
      data: [
        { userId: me.id, threadId, role: null },
        { userId: alice.id, threadId, role: null },
      ],
    });
  }

  // ── 2. PENDING federated friend (carol @ ccc.local) → Pending tab (carol is the inviter) ─────
  const carol = await prisma.user.upsert({
    where: { account_domain: { account: 'carol', domain: TEST_DOMAIN_PENDING } },
    create: {
      account: 'carol',
      domain: TEST_DOMAIN_PENDING,
      isForeigner: true,
      hashPwd: cryptoRandom(),
      name: 'Carol',
      avatar: '',
      bio: 'federated test requester',
    },
    update: { isForeigner: true, name: 'Carol', isDeleted: false },
  });
  await prisma.invite.upsert({
    where: { origin_originId: { origin: TEST_DOMAIN_PENDING, originId: 'seed-carol' } },
    create: {
      kind: 'FRIEND',
      fromUserId: carol.id,
      toUserId: me.id,
      note: 'Hi! Federated test request — ignore/remove me',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      origin: TEST_DOMAIN_PENDING,
      originId: 'seed-carol',
    },
    update: {
      fromUserId: carol.id,
      status: 'PENDING',
      note: 'Hi! Federated test request — ignore/remove me',
      expiresAt: new Date(Date.now() + INVITE_TTL_MS),
    },
  });
  await prisma.user.update({ where: { id: me.id }, data: { hasUrFriendReq: true } });

  console.log(`\nSeeded federated test friends for: ${me.account} (id=${me.id}, domain=local).`);
  console.log('  • thread list : alice @ bbb.local  (APPROVED P2P)');
  console.log('  • pending tab : carol @ ccc.local  (incoming PENDING invite)');
  console.log('Log in as that user to see the globe + domain badges. Remove with:');
  console.log('  npx tsx scripts/unseed-fed-test-friends.ts\n');
}

/** The active P2P thread two users share, or null (mirrors ThreadParticipantService.findP2PThreadBetween). */
async function findP2PThreadBetween(userX: number, userY: number): Promise<number | null> {
  const mine = await prisma.threadParticipant.findMany({
    where: { userId: userX, leftAt: null, thread: { type: 'P2P' } },
    select: { threadId: true },
  });
  if (mine.length === 0) return null;
  const peer = await prisma.threadParticipant.findFirst({
    where: { userId: userY, leftAt: null, threadId: { in: mine.map((m) => m.threadId) } },
    select: { threadId: true },
  });
  return peer?.threadId ?? null;
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
