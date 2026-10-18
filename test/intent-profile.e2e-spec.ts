import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  groupAccount,
  groupMeta,
  groupMetaMemberFeed,
  messageThread,
  profileTable,
  relationshipIntent,
  relationshipPair,
} from '../src/database/schema.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('exact directed intent account-profile disclosure', () => {
  const suffix = Date.now().toString(36);
  const localUser = `intent-local-${suffix}`;
  const remoteDomain = `intent-peer-${suffix}.test`;
  const remoteUser = `remote-${suffix}`;
  const groupName = `!intent-group-${suffix}`;
  let mod: TestingModule;
  let database: DatabaseService;
  let profiles: FederationProfileService;
  let namespaceId: number;
  let userId: number;
  let groupId: number;
  let threadId: number;

  beforeAll(async () => {
    // Resolve real dependencies without starting schedulers or listeners.
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = mod.get(DatabaseService);
    profiles = mod.get(FederationProfileService);
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
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 1,
        displayName: 'First',
      },
      {
        account: localUser,
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
        groupAccountId: groupId,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await database.db
      .insert(groupMeta)
      .values({ threadId, profileRev: 3, metaEndId: 1 });
    await database.db.insert(groupMetaMemberFeed).values({
      threadId,
      feedId: 1,
      operation: 'GROUP_PROFILE',
      body: { account: groupName, namespaceId: 0, profileRev: 3 },
    });
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
    await mod.close();
  });

  it('serves only the authored exact user intent through account profile lookup', async () => {
    expect(
      await profiles.getAuthorizedAccountProfile(localUser, 0, 1, namespaceId),
    ).toMatchObject({
      account: localUser,
      profileRev: 1,
      displayName: 'First',
    });
    expect(
      await profiles.getAuthorizedAccountProfile(localUser, 0, 2, namespaceId),
    ).toBeNull();
    expect(
      await profiles.getAuthorizedAccountProfile(localUser, 0, 1, 0),
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
      await profiles.getAuthorizedAccountProfile(localUser, 0, 1, namespaceId),
    ).toBeNull();
  });

  it('serves the current group Meta profile to its authorized member counterpart', async () => {
    expect(
      await profiles.getAuthorizedAccountProfile(groupName, 0, 3, namespaceId),
    ).toMatchObject({
      account: groupName,
      profileRev: 3,
      displayName: 'Local group',
    });
  });
});
