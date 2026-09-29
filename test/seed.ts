import {
  groupState as group,
  readGroupState,
} from '../src/group/shared/group-state.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../src/user/account-address.js';
// In-process e2e seeding helpers for the admin-provisioned login model.
//
// Self-registration is closed (PUBLIC_CONFIG.registrationOpen = false) and password login is disabled
// under APP_OTP_AND_QR, so the old register→HTTP-login seeding no longer works (and was never correct for
// OTP/QR accounts, which carry no password). These helpers insert users + sessions directly through Drizzle +
// SessionTokenService off the in-process app — the right fixtures for specs that need an authenticated
// user but don't care HOW they authenticated. For the process-boundary federation e2e, see
// federation-test-helpers.ts, which uses its own Drizzle client.
import type { INestApplication } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import {
  account as accountTable,
  federatedPeer,
  identityNamespace,
  profileTable,
  relationshipIntent,
  relationshipPair,
  accountThreadState,
  account as user,
} from '../src/database/schema';
import type { Database } from '../src/database/database.service';
import {
  SessionTokenService,
  type SessionClient,
} from '../src/auth/session-token.service';
import { PasswordHasher } from '../src/auth/password-hasher.service';

export interface SeededUser {
  id: number;
  account: string;
}

export async function seedFederatedPeerNamespace(
  database: Database,
  domain: string,
): Promise<number> {
  const [existing] = await database
    .select({ id: identityNamespace.id })
    .from(identityNamespace)
    .where(
      and(
        eq(identityNamespace.domain, domain),
        isNull(identityNamespace.retiredAt),
      ),
    )
    .limit(1);
  const namespaceId =
    existing?.id ??
    (
      await database
        .insert(identityNamespace)
        .values({
          domain,
          rootKeyFingerprint: `sha256:e2e:${domain}`,
          rootPublicKey: Buffer.alloc(32, domain.length).toString('base64'),
          identityPinnedAt: new Date(),
        })
        .returning({ id: identityNamespace.id })
    )[0].id;
  await database
    .insert(federatedPeer)
    .values({ domain, activeNamespaceId: namespaceId, trustLevel: 'available' })
    .onConflictDoUpdate({
      target: federatedPeer.domain,
      set: { activeNamespaceId: namespaceId, trustLevel: 'available' },
    });
  return namespaceId;
}

/** The local endpoint (namespace 0) is always pair side A; two local
 * endpoints fall back to account order for a deterministic layout. */
function localEndpointFirst(
  left: { account: string; namespaceId: number },
  right: { account: string; namespaceId: number },
): number {
  const leftRemote = left.namespaceId !== 0 ? 1 : 0;
  const rightRemote = right.namespaceId !== 0 ? 1 : 0;
  return (
    leftRemote - rightRemote || left.account.localeCompare(right.account)
  );
}

/** Resolve the fixed GROUP(A) -> USER(B) relationship pair used by roster assertions. */
export async function findGroupRelationship(
  database: Database,
  groupId: number,
  memberUserId: AccountTarget,
) {
  const [groupIdentity, memberIdentity] = await Promise.all([
    readGroupState(database, eq(group.id, groupId)),
    accountAddressInTx(database, memberUserId),
  ]);
  if (!groupIdentity || !memberIdentity)
    throw new Error('group relationship endpoint missing');
  const pair = await database.query.relationshipPair.findFirst({
    where: and(
      eq(relationshipPair.kind, 'GROUP_MEMBER'),
      eq(relationshipPair.endpointAType, 'GROUP'),
      eq(relationshipPair.endpointAAccount, groupIdentity.account),
      eq(relationshipPair.endpointANamespaceId, groupIdentity.namespaceId),
      eq(relationshipPair.endpointBType, 'USER'),
      eq(relationshipPair.endpointBAccount, memberIdentity.account),
      eq(relationshipPair.endpointBNamespaceId, memberIdentity.namespaceId),
    ),
  });
  return {
    pair,
    groupEndpoint: {
      account: groupIdentity.account,
      namespaceId: groupIdentity.namespaceId,
    },
    memberEndpoint: {
      account: memberIdentity.account,
      namespaceId: memberIdentity.namespaceId,
    },
  };
}

/** Resolve the canonical address pair and authored sides used by relationship assertions. */
export async function findP2PRelationship(
  database: Database,
  firstUserId: AccountTarget,
  secondUserId: AccountTarget,
) {
  const [first, second] = await Promise.all([
    accountAddressInTx(database, firstUserId),
    accountAddressInTx(database, secondUserId),
  ]);
  if (
    first.account === second.account &&
    first.domain === second.domain &&
    first.namespaceId === second.namespaceId
  )
    throw new Error('relationship endpoints must differ');
  const endpoints = [first, second].sort(localEndpointFirst);
  const pair = await database.query.relationshipPair.findFirst({
    where: and(
      eq(relationshipPair.endpointAType, 'USER'),
      eq(relationshipPair.endpointAAccount, endpoints[0].account),
      eq(relationshipPair.endpointANamespaceId, endpoints[0].namespaceId),
      eq(relationshipPair.endpointBType, 'USER'),
      eq(relationshipPair.endpointBAccount, endpoints[1].account),
      eq(relationshipPair.endpointBNamespaceId, endpoints[1].namespaceId),
    ),
  });
  return {
    pair,
    firstEndpoint: { account: first.account, namespaceId: first.namespaceId },
    secondEndpoint: {
      account: second.account,
      namespaceId: second.namespaceId,
    },
  };
}

/** Seed the two directed facts required for an active P2P relationship. */
export async function seedAcceptedRelationship(
  database: Database,
  firstUserId: AccountTarget,
  secondUserId: AccountTarget,
  threadId: number,
): Promise<void> {
  const updatedAt = new Date();
  await database.transaction(async (tx) => {
    const [first, second] = await Promise.all([
      accountAddressInTx(tx, firstUserId),
      accountAddressInTx(tx, secondUserId),
    ]);
    const localAccountIds = [firstUserId, secondUserId]
      .filter((target): target is number => typeof target === 'number')
      .map((id) => ({ id }));
    const endpoints = [first, second].sort(localEndpointFirst);
    const revisions = await Promise.all(
      endpoints.map(async (identity) => {
        if (identity.domain !== 'local') return 0;
        const row = await tx.query.account.findFirst({
          where: eq(accountTable.account, identity.account),
          columns: { defaultProfileRev: true },
        });
        return row?.defaultProfileRev ?? 0;
      }),
    );
    const [pair] = await tx
      .insert(relationshipPair)
      .values({
        kind: 'P2P',
        endpointAType: 'USER',
        endpointAAccount: endpoints[0].account,
        endpointANamespaceId: endpoints[0].namespaceId,
        endpointBType: 'USER',
        endpointBAccount: endpoints[1].account,
        endpointBNamespaceId: endpoints[1].namespaceId,
        threadId,
        active: true,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          relationshipPair.endpointAType,
          relationshipPair.endpointAAccount,
          relationshipPair.endpointBType,
          relationshipPair.endpointBAccount,
          relationshipPair.endpointBNamespaceId,
        ],
        set: { threadId, active: true, updatedAt },
      })
      .returning({ id: relationshipPair.id });
    await tx
      .insert(relationshipIntent)
      .values(
        [0, 1].map((index) => ({
          authorAccount: endpoints[index].account,
          authorNamespaceId: endpoints[index].namespaceId,
          receiverAccount: endpoints[1 - index].account,
          receiverNamespaceId: endpoints[1 - index].namespaceId,
          profileNamespaceId: endpoints[index].namespaceId,
          profileRev: revisions[index],
          status: 'ACCEPTED',
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
          requestedAt: updatedAt,
          updatedAt,
        })),
      )
      .onConflictDoUpdate({
        target: [
          relationshipIntent.authorAccount,
          relationshipIntent.authorNamespaceId,
          relationshipIntent.receiverAccount,
          relationshipIntent.receiverNamespaceId,
        ],
        set: {
          status: 'ACCEPTED',
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
          profileRev: sql`excluded."profileRev"`,
          requestedAt: updatedAt,
          expiresAt: null,
          updatedAt,
        },
      });
    const participantRows = localAccountIds.map((localAccount) => ({
      accountId: localAccount.id,
      threadId,
    }));
    if (participantRows.length > 0)
      await tx
        .insert(accountThreadState)
        .values(participantRows)
        .onConflictDoNothing({
          target: [accountThreadState.accountId, accountThreadState.threadId],
        });
  });
}

/** Insert a local user directly. `password` (optional) is hashed via the app's PasswordHasher
 *  (Argon2id + pepper — the exact path /auth/login verifies against); omit it for a passwordless
 *  (OTP/QR-only) account. */
export async function seedUser(
  app: INestApplication,
  account: string,
  opts: { name?: string; password?: string } = {},
): Promise<SeededUser> {
  const database = app.get(DatabaseService);
  const passwordHash =
    opts.password === undefined
      ? null
      : await new PasswordHasher().hash(opts.password);
  const u = await database.db.transaction(async (tx) => {
    const [created] = await tx
      .insert(user)
      .values({
        account,
        domain: 'local',
        hashPwd: passwordHash,
        mustChangePassword: false,
        defaultProfileRev: 1,
        updatedAt: new Date(),
      })
      .returning({ id: user.id, account: user.account });
    await tx.insert(profileTable).values({
      account: created.account,
      domain: 'local',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 1,
      displayName: opts.name ?? account,
      avatar: '',
      bio: '',
    });
    return created;
  });
  return u;
}

/** Issue a session token directly via the in-process SessionTokenService. Returns the plaintext (the
 *  Bearer credential the global SessionAuthGuard validates). */
export function seedSession(
  app: INestApplication,
  userId: number,
  client: SessionClient = 'app',
  opts: { device?: string } = {},
): Promise<string> {
  return app.get(SessionTokenService).issue(userId, client, {
    device: opts.device,
    ip: '127.0.0.1',
  });
}

/** Seed a user + an authenticated session — the direct replacement for the old register+login pair.
 *  Returns { id, account, token }. */
export async function seedUserWithSession(
  app: INestApplication,
  account: string,
  opts: { name?: string; client?: SessionClient; device?: string } = {},
): Promise<SeededUser & { token: string }> {
  const user = await seedUser(app, account, { name: opts.name });
  const token = await seedSession(app, user.id, opts.client ?? 'app', {
    device: opts.device,
  });
  return { ...user, token };
}
