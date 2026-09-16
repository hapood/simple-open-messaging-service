import {
  groupState as group,
  readGroupState,
} from '../src/group/business/shared/group-state.js';
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

function relationshipNamespaceForFixture(
  namespaceIds: readonly number[],
): number {
  const federationNamespaceIds = new Set(
    namespaceIds.filter((namespaceId) => namespaceId !== 0),
  );
  if (federationNamespaceIds.size > 1)
    throw new Error('relationship fixture spans federation namespaces');
  return federationNamespaceIds.values().next().value ?? 0;
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
  const relationshipNamespaceId = relationshipNamespaceForFixture([
    groupIdentity.namespaceId,
    memberIdentity.namespaceId,
  ]);
  const pair = await database.query.relationshipPair.findFirst({
    where: and(
      eq(relationshipPair.kind, 'GROUP_MEMBER'),
      eq(relationshipPair.endpointAType, 'GROUP'),
      eq(relationshipPair.endpointAAccount, groupIdentity.account),
      eq(relationshipPair.endpointADomain, groupIdentity.domain),
      eq(relationshipPair.endpointANamespaceId, relationshipNamespaceId),
      eq(relationshipPair.endpointBType, 'USER'),
      eq(relationshipPair.endpointBAccount, memberIdentity.account),
      eq(relationshipPair.endpointBDomain, memberIdentity.domain),
      eq(relationshipPair.endpointBNamespaceId, relationshipNamespaceId),
    ),
  });
  return { pair, groupSide: 'A' as const, memberSide: 'B' as const };
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
  const relationshipNamespaceId = relationshipNamespaceForFixture([
    first.namespaceId,
    second.namespaceId,
  ]);
  const endpoints = [first, second].sort(
    (left, right) =>
      left.domain.localeCompare(right.domain) ||
      left.account.localeCompare(right.account),
  );
  const pair = await database.query.relationshipPair.findFirst({
    where: and(
      eq(relationshipPair.endpointAType, 'USER'),
      eq(relationshipPair.endpointAAccount, endpoints[0].account),
      eq(relationshipPair.endpointADomain, endpoints[0].domain),
      eq(relationshipPair.endpointANamespaceId, relationshipNamespaceId),
      eq(relationshipPair.endpointBType, 'USER'),
      eq(relationshipPair.endpointBAccount, endpoints[1].account),
      eq(relationshipPair.endpointBDomain, endpoints[1].domain),
      eq(relationshipPair.endpointBNamespaceId, relationshipNamespaceId),
    ),
  });
  return {
    pair,
    firstSide: endpoints[0] === first ? ('A' as const) : ('B' as const),
    secondSide: endpoints[0] === second ? ('A' as const) : ('B' as const),
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
    const identities = [first, second];
    const relationshipNamespaceId = relationshipNamespaceForFixture(
      identities.map((identity) => identity.namespaceId),
    );
    const localAccountIds = [firstUserId, secondUserId]
      .filter((target): target is number => typeof target === 'number')
      .map((id) => ({ id }));
    const endpoints = [first, second].sort(
      (left, right) =>
        left.domain.localeCompare(right.domain) ||
        left.account.localeCompare(right.account),
    );
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
        endpointADomain: endpoints[0].domain,
        endpointANamespaceId: relationshipNamespaceId,
        endpointBType: 'USER',
        endpointBAccount: endpoints[1].account,
        endpointBDomain: endpoints[1].domain,
        endpointBNamespaceId: relationshipNamespaceId,
        threadId,
        active: true,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: [
          relationshipPair.endpointAType,
          relationshipPair.endpointAAccount,
          relationshipPair.endpointADomain,
          relationshipPair.endpointANamespaceId,
          relationshipPair.endpointBType,
          relationshipPair.endpointBAccount,
          relationshipPair.endpointBDomain,
          relationshipPair.endpointBNamespaceId,
        ],
        set: { threadId, active: true, updatedAt },
      })
      .returning({ id: relationshipPair.id });
    await tx
      .insert(relationshipIntent)
      .values([
        {
          pairId: pair.id,
          authorSide: 'A',
          profileRev: revisions[0],
          status: 'ACCEPTED',
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
          requestedAt: updatedAt,
          updatedAt,
        },
        {
          pairId: pair.id,
          authorSide: 'B',
          profileRev: revisions[1],
          status: 'ACCEPTED',
          messageEndSeq: 0,
          tombstoneEndSeq: 0,
          requestedAt: updatedAt,
          updatedAt,
        },
      ])
      .onConflictDoUpdate({
        target: [relationshipIntent.pairId, relationshipIntent.authorSide],
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
      namespaceId: 0,
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
