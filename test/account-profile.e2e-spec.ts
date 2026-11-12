import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { withMessageDigest } from './support/message-fixture.js';
import { and, eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service.js';
import {
  account,
  accountThreadState,
  groupAccount,
  groupMeta,
  groupMetaMemberFeed,
  message,
  messageThread,
  peerStateFeed,
  profileTable,
  relationshipIntent,
  relationshipPair,
  threadAudience,
} from '../src/database/schema.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('exact account profile by current account evidence', () => {
  const suffix = Date.now().toString(36);
  const localUser = `author-${suffix}`;
  const signer = `origin-${suffix}.test`;
  const signerUser = `peer-${suffix}`;
  const remoteGroup = `!mirror-${suffix}`;
  const localGroup = `!origin-${suffix}`;
  let mod: TestingModule;
  let database: DatabaseService;
  let profiles: FederationProfileService;
  let ns: number;
  let outsiderNamespaceId: number;
  let userId: number;
  let groupId: number;
  let p2pThreadId: number;
  let mirrorThreadId: number;
  let originThreadId: number;
  let pairIds: bigint[];

  const userProfile = (rev: number) =>
    profiles.getAuthorizedAccountProfile(localUser, 0, rev, ns);
  const groupProfile = (rev: number, signerNamespaceId = ns) =>
    profiles.getAuthorizedAccountProfile(localGroup, 0, rev, signerNamespaceId);
  const setPublishedEnd = (headAccount: string, end: number) =>
    database.db
      .update(peerStateFeed)
      .set({
        body: { messageEndSeq: end, tombstoneEndSeq: 0 },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(peerStateFeed.namespaceId, ns),
          eq(peerStateFeed.account, headAccount),
        ),
      );

  beforeAll(async () => {
    // Resolve real dependencies without starting schedulers or listeners.
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = mod.get(DatabaseService);
    profiles = mod.get(FederationProfileService);
    ns = await seedFederatedPeerNamespace(database.db, signer);
    outsiderNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      `outsider-${suffix}.test`,
    );
    const [user] = await database.db
      .insert(account)
      .values({ account: localUser })
      .returning({ id: account.id });
    userId = user.id;
    await database.db.insert(profileTable).values([
      {
        account: localUser,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 4,
        generatedAt: 1_700_000_000_000,
        displayName: 'P2P revision',
      },
      {
        account: localUser,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 7,
        generatedAt: 1_700_000_000_000,
        displayName: 'Group message revision',
      },
      {
        account: localGroup,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 3,
        generatedAt: 1_700_000_000_000,
        displayName: 'Group revision',
      },
      {
        account: localGroup,
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        profileRev: 5,
        generatedAt: 1_700_000_000_000,
        displayName: 'Unselected group revision',
      },
    ]);
    const [group] = await database.db
      .insert(groupAccount)
      .values({
        account: localGroup,
        updatedAt: new Date(),
      })
      .returning({ id: groupAccount.id });
    groupId = group.id;
    const threads = await database.db
      .insert(messageThread)
      .values([
        { type: 'P2P', updatedAt: new Date() },
        {
          type: 'GROUP',
          groupAccount: remoteGroup,
          authorityNamespaceId: ns,
          updatedAt: new Date(),
        },
        {
          type: 'GROUP',
          groupAccount: localGroup,
          groupAccountId: groupId,
          updatedAt: new Date(),
        },
      ])
      .returning({ id: messageThread.id });
    [p2pThreadId, mirrorThreadId, originThreadId] = threads.map((t) => t.id);
    await database.db.insert(accountThreadState).values({
      accountId: userId,
      threadId: mirrorThreadId,
      role: 'MEMBER',
      updatedAt: new Date(),
    });
    await database.db
      .insert(groupMeta)
      .values([
        { threadId: mirrorThreadId },
        { threadId: originThreadId, metaEndId: 1, profileRev: 3 },
      ]);
    await database.db.insert(groupMetaMemberFeed).values({
      threadId: originThreadId,
      feedId: 1,
      operation: 'GROUP_PROFILE',
      body: { account: localGroup, namespaceId: 0, profileRev: 3 },
      updatedAt: new Date(),
    });
    // Local endpoints sit on side A at namespace 0; remote signers and the
    // mirrored remote group carry their own namespaces on side B.
    const pairs = await database.db
      .insert(relationshipPair)
      .values([
        {
          kind: 'P2P',
          threadId: p2pThreadId,
          endpointAType: 'USER',
          endpointAAccount: localUser,
          endpointANamespaceId: 0,
          endpointBType: 'USER',
          endpointBAccount: signerUser,
          endpointBNamespaceId: ns,
          active: true,
          established: true,
        },
        {
          kind: 'GROUP_MEMBER',
          threadId: mirrorThreadId,
          endpointAType: 'USER',
          endpointAAccount: localUser,
          endpointANamespaceId: 0,
          endpointBType: 'GROUP',
          endpointBAccount: remoteGroup,
          endpointBNamespaceId: ns,
          active: true,
          established: true,
        },
        {
          kind: 'GROUP_MEMBER',
          threadId: originThreadId,
          endpointAType: 'GROUP',
          endpointAAccount: localGroup,
          endpointANamespaceId: 0,
          endpointBType: 'USER',
          endpointBAccount: signerUser,
          endpointBNamespaceId: ns,
          active: true,
          established: true,
        },
      ])
      .returning({ id: relationshipPair.id });
    pairIds = pairs.map((pair) => pair.id);
    await database.db.insert(relationshipIntent).values([
      {
        authorAccount: localUser,
        authorNamespaceId: 0,
        profileNamespaceId: 0,
        receiverAccount: signerUser,
        receiverNamespaceId: ns,
        status: 'ACCEPTED',
        profileRev: 0,
        note: '',
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        statusChangedAt: new Date(),
      },
      {
        authorAccount: remoteGroup,
        authorNamespaceId: ns,
        profileNamespaceId: ns,
        receiverAccount: localUser,
        receiverNamespaceId: 0,
        status: 'ACCEPTED',
        profileRev: 0,
        note: '',
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        statusChangedAt: new Date(),
      },
      {
        authorAccount: localGroup,
        authorNamespaceId: 0,
        profileNamespaceId: 0,
        receiverAccount: signerUser,
        receiverNamespaceId: ns,
        status: 'ACCEPTED',
        profileRev: 0,
        note: '',
        messageEndSeq: 0,
        tombstoneEndSeq: 0,
        statusChangedAt: new Date(),
      },
    ]);
    await database.db.insert(message).values(
      withMessageDigest([
        {
          threadId: p2pThreadId,
          seq: 1,
          profileRev: 4,
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
          creatorAccount: localUser,

          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'p2p' }),
          updatedAt: new Date(),
        },
        {
          threadId: mirrorThreadId,
          seq: 1,
          profileRev: 7,
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
          creatorAccount: localUser,

          contentType: 'PURE_TEXT',
          content: JSON.stringify({ text: 'group' }),
          updatedAt: new Date(),
        },
      ]),
    );
    await database.db.insert(peerStateFeed).values([
      {
        namespaceId: ns,
        account: localUser,
        eventType: 'THREAD_CONTENT_HEAD',
        subjectAccount: signerUser,
        subjectNamespaceId: ns,
        feedId: 1n,
        body: { messageEndSeq: 0, tombstoneEndSeq: 0 },
        updatedAt: new Date(),
      },
      {
        namespaceId: ns,
        account: remoteGroup,
        eventType: 'THREAD_CONTENT_HEAD',
        feedId: 2n,
        body: { messageEndSeq: 0, tombstoneEndSeq: 0 },
        updatedAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    await database.db
      .delete(peerStateFeed)
      .where(eq(peerStateFeed.namespaceId, ns));
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.targetNamespaceId, ns));
    await database.db
      .delete(message)
      .where(eq(message.creatorAccount, localUser));
    await database.db
      .delete(accountThreadState)
      .where(eq(accountThreadState.accountId, userId));
    await database.db
      .delete(relationshipIntent)
      .where(eq(relationshipIntent.authorAccount, localUser));
    await database.db
      .delete(relationshipIntent)
      .where(eq(relationshipIntent.authorAccount, remoteGroup));
    await database.db
      .delete(relationshipIntent)
      .where(eq(relationshipIntent.authorAccount, localGroup));
    for (const pairId of pairIds)
      await database.db
        .delete(relationshipPair)
        .where(eq(relationshipPair.id, pairId));
    for (const threadId of [p2pThreadId, mirrorThreadId, originThreadId])
      await database.db
        .delete(messageThread)
        .where(eq(messageThread.id, threadId));
    await database.db.delete(groupAccount).where(eq(groupAccount.id, groupId));
    await database.db.delete(account).where(eq(account.id, userId));
    await database.db
      .delete(profileTable)
      .where(eq(profileTable.account, localGroup));
    await database.db
      .delete(profileTable)
      .where(eq(profileTable.account, localUser));
    await mod.close();
  });

  beforeEach(async () => {
    await database.db
      .update(peerStateFeed)
      .set({
        body: { messageEndSeq: 0, tombstoneEndSeq: 0 },
        updatedAt: new Date(),
      })
      .where(eq(peerStateFeed.namespaceId, ns));
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.targetNamespaceId, ns));
    await database.db
      .update(message)
      .set({ isDeleted: false })
      .where(eq(message.creatorAccount, localUser));
    await database.db
      .update(relationshipPair)
      .set({ active: true })
      .where(eq(relationshipPair.threadId, mirrorThreadId));
    await database.db
      .update(relationshipIntent)
      .set({ status: 'ACCEPTED', expiresAt: null })
      .where(
        and(
          eq(relationshipIntent.receiverNamespaceId, ns),
          eq(relationshipIntent.authorNamespaceId, 0),
        ),
      );
    await database.db
      .update(relationshipIntent)
      .set({ status: 'ACCEPTED', expiresAt: null })
      .where(
        and(
          eq(relationshipIntent.authorAccount, remoteGroup),
          eq(relationshipIntent.authorNamespaceId, ns),
        ),
      );
    await database.db
      .update(relationshipIntent)
      .set({ status: 'ACCEPTED', expiresAt: null })
      .where(
        and(
          eq(relationshipIntent.authorAccount, localGroup),
          eq(relationshipIntent.authorNamespaceId, 0),
        ),
      );
  });

  it('requires a published P2P interval and the exact message revision', async () => {
    expect(await userProfile(4)).toBeNull();
    await database.db
      .update(peerStateFeed)
      .set({ body: { messageEndSeq: 'bad' } })
      .where(
        and(
          eq(peerStateFeed.namespaceId, ns),
          eq(peerStateFeed.account, localUser),
        ),
      );
    expect(await userProfile(4)).toBeNull();
    await setPublishedEnd(localUser, 1);
    expect(await userProfile(4)).toMatchObject({
      account: localUser,
      profileRev: 4,
      generatedAt: 1_700_000_000_000,
      displayName: 'P2P revision',
    });
    expect(await userProfile(7)).toBeNull();
    await database.db.insert(threadAudience).values({
      threadId: p2pThreadId,
      targetNamespaceId: ns,
      messageAccessAfterSeq: 1,
    });
    expect(await userProfile(4)).toBeNull();
  });

  it('allows only the group origin to fetch a confirmed member message revision', async () => {
    expect(await userProfile(7)).toBeNull();
    await setPublishedEnd(remoteGroup, 1);
    expect(await userProfile(7)).toMatchObject({
      profileRev: 7,
      generatedAt: 1_700_000_000_000,
      displayName: 'Group message revision',
    });
    await database.db
      .update(relationshipPair)
      .set({ active: false })
      .where(eq(relationshipPair.id, pairIds[1]));
    expect(await userProfile(7)).toBeNull();
    await database.db
      .update(relationshipPair)
      .set({ active: true })
      .where(eq(relationshipPair.id, pairIds[1]));
    await database.db
      .update(relationshipIntent)
      .set({ status: 'REVOKED' })
      .where(
        and(
          eq(relationshipIntent.authorAccount, remoteGroup),
          eq(relationshipIntent.authorNamespaceId, ns),
          eq(relationshipIntent.receiverAccount, localUser),
          eq(relationshipIntent.receiverNamespaceId, 0),
        ),
      );
    expect(await userProfile(7)).toBeNull();
  });

  it('does not disclose a deleted or revoked P2P message', async () => {
    await setPublishedEnd(localUser, 1);
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.threadId, p2pThreadId));
    await database.db
      .update(message)
      .set({ isDeleted: true })
      .where(eq(message.threadId, p2pThreadId));
    expect(await userProfile(4)).toBeNull();
    await database.db
      .update(message)
      .set({ isDeleted: false })
      .where(eq(message.threadId, p2pThreadId));
    expect(await userProfile(4)).toMatchObject({ profileRev: 4 });
    await database.db
      .update(relationshipIntent)
      .set({ status: 'REVOKED' })
      .where(
        and(
          eq(relationshipIntent.authorAccount, localUser),
          eq(relationshipIntent.authorNamespaceId, 0),
          eq(relationshipIntent.receiverAccount, signerUser),
          eq(relationshipIntent.receiverNamespaceId, ns),
        ),
      );
    expect(await userProfile(4)).toBeNull();
  });

  it('selects the current group-profile Meta reference, not a group message', async () => {
    expect(await groupProfile(3)).toMatchObject({
      account: localGroup,
      profileRev: 3,
      generatedAt: 1_700_000_000_000,
      displayName: 'Group revision',
    });
    expect(await groupProfile(5)).toBeNull();
    expect(await groupProfile(3, outsiderNamespaceId)).toBeNull();
    await database.db
      .update(relationshipIntent)
      .set({ status: 'REVOKED' })
      .where(
        and(
          eq(relationshipIntent.authorAccount, localGroup),
          eq(relationshipIntent.authorNamespaceId, 0),
          eq(relationshipIntent.receiverAccount, signerUser),
          eq(relationshipIntent.receiverNamespaceId, ns),
        ),
      );
    expect(await groupProfile(3)).toBeNull();
  });
});
