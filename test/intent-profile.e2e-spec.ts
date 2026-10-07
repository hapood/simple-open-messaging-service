import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { localIdentityDomain } from './support/local-domain.js';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  groupAccount,
  messageThread,
  profileTable,
  relationshipIntent,
  relationshipPair,
} from '../src/database/schema.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('exact directed intent profile disclosure', () => {
  const suffix = Date.now().toString(36);
  const localUser = `intent-local-${suffix}`;
  const remoteDomain = `intent-peer-${suffix}.test`;
  const remoteUser = `remote-${suffix}`;
  const groupName = `!intent-group-${suffix}`;
  let database: DatabaseService;
  let profiles: FederationProfileService;
  let namespaceId: number;
  let userId: number;
  let groupId: number;
  let threadId: number;

  beforeAll(async () => {
    database = new DatabaseService();
    profiles = new FederationProfileService(database, {} as never, {} as never);
    namespaceId = await seedFederatedPeerNamespace(database.db, remoteDomain);
    const [user] = await database.db
      .insert(account)
      .values({
        account: localUser,
        defaultProfileRev: 2,
      })
      .returning({ id: account.id });
    userId = user.id;
    await database.db.insert(profileTable).values([
      {
        account: localUser,
        namespaceId: 0,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 1,
        displayName: 'First',
      },
      {
        account: localUser,
        namespaceId: 0,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 2,
        displayName: 'Second',
      },
    ]);
    const [group] = await database.db
      .insert(groupAccount)
      .values({
        account: groupName,
        defaultProfileRev: 3,
        updatedAt: new Date(),
      })
      .returning({ id: groupAccount.id });
    groupId = group.id;
    await database.db.insert(profileTable).values({
      account: groupName,
      namespaceId: 0,
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 3,
      displayName: 'Local group',
    });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount: groupName,
        groupDomain: 'local',
        groupAccountId: groupId,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await database.db.insert(relationshipPair).values([
      {
        kind: 'P2P',
        endpointAType: 'USER',
        endpointAAccount: localUser,
        endpointANamespaceId: 0,
        endpointBType: 'USER',
        endpointBAccount: remoteUser,
        endpointBNamespaceId: namespaceId,
      },
      {
        kind: 'GROUP_MEMBER',
        threadId,
        endpointAType: 'GROUP',
        endpointAAccount: groupName,
        endpointANamespaceId: 0,
        endpointBType: 'USER',
        endpointBAccount: remoteUser,
        endpointBNamespaceId: namespaceId,
      },
    ]);
    const now = new Date();
    await database.db.insert(relationshipIntent).values([
      {
        authorAccount: localUser,
        authorNamespaceId: 0,
        profileNamespaceId: 0,
        receiverAccount: remoteUser,
        receiverNamespaceId: namespaceId,
        status: 'REQUESTED',
        profileRev: 1,
        note: '',
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        requestedAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      },
      {
        authorAccount: groupName,
        authorNamespaceId: 0,
        profileNamespaceId: 0,
        receiverAccount: remoteUser,
        receiverNamespaceId: namespaceId,
        status: 'ACCEPTED',
        profileRev: 3,
        note: '',
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        requestedAt: now,
      },
    ]);
  });

  afterAll(async () => {
    await database.db
      .delete(relationshipIntent)
      .where(
        and(
          eq(relationshipIntent.authorAccount, localUser),
          eq(relationshipIntent.receiverAccount, remoteUser),
        ),
      );
    await database.db
      .delete(relationshipIntent)
      .where(
        and(
          eq(relationshipIntent.authorAccount, groupName),
          eq(relationshipIntent.receiverAccount, remoteUser),
        ),
      );
    await database.db
      .delete(relationshipPair)
      .where(eq(relationshipPair.kind, 'P2P'));
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
    await database.db.delete(groupAccount).where(eq(groupAccount.id, groupId));
    await database.db.delete(account).where(eq(account.id, userId));
    await database.onApplicationShutdown();
  });

  it('serves only the authored exact user intent, not another retained revision', async () => {
    expect(
      await profiles.getAuthorizedIntentProfile(
        localUser,
        remoteUser,
        0,
        1,
        remoteDomain,
        namespaceId,
      ),
    ).toMatchObject({
      account: localUser,
      profileRev: 1,
      displayName: 'First',
    });
    expect(
      await profiles.getAuthorizedIntentProfile(
        localUser,
        remoteUser,
        0,
        2,
        remoteDomain,
        namespaceId,
      ),
    ).toBeNull();
    expect(
      await profiles.getAuthorizedIntentProfile(
        localUser,
        'someone-else',
        0,
        1,
        remoteDomain,
        namespaceId,
      ),
    ).toBeNull();
    expect(
      await profiles.getAuthorizedIntentProfile(
        localUser,
        remoteUser,
        0,
        1,
        remoteDomain,
        0,
      ),
    ).toBeNull();
    await database.db
      .update(relationshipIntent)
      .set({ status: 'REVOKED', expiresAt: null })
      .where(
        and(
          eq(relationshipIntent.authorAccount, localUser),
          eq(relationshipIntent.authorNamespaceId, 0),
          eq(relationshipIntent.receiverAccount, remoteUser),
          eq(relationshipIntent.receiverNamespaceId, namespaceId),
        ),
      );
    expect(
      await profiles.getAuthorizedIntentProfile(
        localUser,
        remoteUser,
        0,
        1,
        remoteDomain,
        namespaceId,
      ),
    ).toBeNull();
  });

  it('also serves a group-authored intent to its exact member counterpart', async () => {
    expect(
      await profiles.getAuthorizedIntentProfile(
        groupName,
        remoteUser,
        0,
        3,
        remoteDomain,
        namespaceId,
      ),
    ).toMatchObject({
      account: groupName,
      profileRev: 3,
      displayName: 'Local group',
    });
  });
});
