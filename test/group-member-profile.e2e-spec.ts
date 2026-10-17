import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withMessageDigest } from './support/message-fixture.js';
import { and, eq } from 'drizzle-orm';
import { Test, type TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
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
import { loadFederationConfig } from '../src/federation/federation.config.js';
import { FederationProfileService } from '../src/federation/federation-profile.service.js';
import { seedFederatedPeerNamespace } from './seed.js';

describe('exact group-member profile disclosure', () => {
  const suffix = Date.now().toString(36);
  const groupName = `!profile-${suffix}`;
  const signerDomain = `member-signer-${suffix}.test`;
  const memberDomain = `member-home-${suffix}.test`;
  const signerAccount = `signer-${suffix}`;
  const memberAccount = `subject-${suffix}`;
  const localDomain = loadFederationConfig().domain;
  let mod: TestingModule;
  let database: DatabaseService;
  let service: FederationProfileService;
  let signerNs: number;
  let memberNs: number;
  let groupId: number;
  let threadId: number;
  let pairIds: bigint[];

  const lookup = (rev: number, namespace = signerNs) =>
    service.getAuthorizedGroupMemberProfile(
      groupName,
      memberAccount,
      memberNs,
      rev,
      namespace,
    );

  beforeAll(async () => {
    // Resolve real dependencies without starting schedulers or listeners.
    mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    database = mod.get(DatabaseService);
    service = mod.get(FederationProfileService);
    signerNs = await seedFederatedPeerNamespace(database.db, signerDomain);
    memberNs = await seedFederatedPeerNamespace(database.db, memberDomain);
    const [group] = await database.db
      .insert(groupAccount)
      .values({
        account: groupName,
        updatedAt: new Date(),
      })
      .returning({ id: groupAccount.id });
    groupId = group.id;
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: 'GROUP',
        groupAccount: groupName,
        groupDomain: localDomain,
        groupAccountId: groupId,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await database.db.insert(groupMeta).values({ threadId, metaEndId: 1 });
    await database.db.insert(groupMetaMemberFeed).values({
      threadId,
      feedId: 1,
      operation: 'MEMBER_UPSERT',
      body: {
        account: memberAccount,
        namespaceId: memberNs,
        role: 'MEMBER',
        profileRev: 4,
      },
      updatedAt: new Date(),
    });
    await database.db.insert(profileTable).values([
      {
        account: memberAccount,
        publisherNamespaceId: memberNs,
        profileNamespaceId: 0,
        profileRev: 4,
        displayName: 'Old snapshot',
      },
      {
        account: memberAccount,
        publisherNamespaceId: memberNs,
        profileNamespaceId: 0,
        profileRev: 7,
        displayName: 'Message snapshot',
      },
    ]);
    const pairs = await database.db
      .insert(relationshipPair)
      .values([
        {
          kind: 'GROUP_MEMBER',
          threadId,
          endpointAType: 'GROUP',
          endpointAAccount: groupName,
          endpointANamespaceId: 0,
          endpointBType: 'USER',
          endpointBAccount: signerAccount,
          endpointBNamespaceId: signerNs,
          active: true,
          established: true,
        },
        {
          kind: 'GROUP_MEMBER',
          threadId,
          endpointAType: 'GROUP',
          endpointAAccount: groupName,
          endpointANamespaceId: 0,
          endpointBType: 'USER',
          endpointBAccount: memberAccount,
          endpointBNamespaceId: memberNs,
          active: true,
          established: true,
        },
      ])
      .returning({ id: relationshipPair.id });
    pairIds = pairs.map((pair) => pair.id);
    await database.db.insert(relationshipIntent).values({
      authorAccount: groupName,
      authorNamespaceId: 0,
      profileNamespaceId: 0,
      receiverAccount: signerAccount,
      receiverNamespaceId: signerNs,
      status: 'ACCEPTED',
      profileRev: 0,
      note: '',
      messageEndSeq: 0,
      tombstoneEndSeq: 0,
      requestedAt: new Date(),
    });
    await database.db.insert(peerStateFeed).values({
      namespaceId: signerNs,
      account: groupName,
      eventType: 'THREAD_CONTENT_HEAD',
      feedId: 1n,
      body: { messageEndSeq: 0, tombstoneEndSeq: 0 },
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.threadId, threadId));
    await database.db
      .delete(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.namespaceId, signerNs),
          eq(peerStateFeed.account, groupName),
        ),
      );
    await database.db.delete(message).where(eq(message.threadId, threadId));
    await database.db
      .delete(relationshipIntent)
      .where(
        and(
          eq(relationshipIntent.authorAccount, groupName),
          eq(relationshipIntent.receiverAccount, signerAccount),
        ),
      );
    for (const id of pairIds)
      await database.db
        .delete(relationshipPair)
        .where(eq(relationshipPair.id, id));
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
    await database.db.delete(groupAccount).where(eq(groupAccount.id, groupId));
    await database.db
      .delete(profileTable)
      .where(eq(profileTable.account, memberAccount));
    await mod.close();
  });

  it('serves exactly the current member reference to a current group audience', async () => {
    expect(await lookup(4)).toMatchObject({
      account: memberAccount,
      namespaceId: memberNs,
      profileRev: 4,
      displayName: 'Old snapshot',
    });
    expect(await lookup(7)).toBeNull();
    expect(await lookup(0)).toBeNull();
    expect(await lookup(4, memberNs)).toBeNull();
  });

  it('serves a distinct message revision only inside the published interval', async () => {
    await database.db.insert(message).values(
      withMessageDigest({
        threadId,
        seq: 1,
        profileRev: 7,
        creatorAccount: memberAccount,
        publisherNamespaceId: memberNs,
        originSeq: 1,
        profileNamespaceId: 0,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'hello' }),
        updatedAt: new Date(),
      }),
    );
    expect(await lookup(7)).toBeNull();
    await database.db
      .update(peerStateFeed)
      .set({
        body: { messageEndSeq: 1, tombstoneEndSeq: 0 },
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(peerStateFeed.namespaceId, signerNs),
          eq(peerStateFeed.account, groupName),
        ),
      );
    expect(await lookup(7)).toMatchObject({
      profileRev: 7,
      displayName: 'Message snapshot',
    });
    await database.db.insert(threadAudience).values({
      threadId,
      targetNamespaceId: signerNs,
      messageAccessAfterSeq: 1,
    });
    expect(await lookup(7)).toBeNull();
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.threadId, threadId));
    await database.db
      .update(message)
      .set({ isDeleted: true })
      .where(eq(message.threadId, threadId));
    expect(await lookup(7)).toBeNull();
    await database.db
      .update(message)
      .set({ isDeleted: false })
      .where(eq(message.threadId, threadId));
    await database.db
      .update(message)
      .set({ localState: 'STUB' })
      .where(eq(message.threadId, threadId));
    expect(await lookup(7)).toMatchObject({ profileRev: 7 });
    await database.db
      .update(message)
      .set({ localState: 'READY' })
      .where(eq(message.threadId, threadId));
    await database.db
      .update(groupMetaMemberFeed)
      .set({
        feedId: 2,
        operation: 'MEMBER_DEPART',
        body: {
          account: memberAccount,
          role: 'MEMBER',
          namespaceId: memberNs,
          profileRev: 4,
        },
      })
      .where(eq(groupMetaMemberFeed.threadId, threadId));
    await database.db
      .update(groupMeta)
      .set({ metaEndId: 2 })
      .where(eq(groupMeta.threadId, threadId));
    await database.db
      .update(relationshipPair)
      .set({ active: false })
      .where(eq(relationshipPair.id, pairIds[1]));
    expect(await lookup(4)).toBeNull();
    expect(await lookup(7)).toMatchObject({ profileRev: 7 });
  });

  it('maps the origin-published member namespace to the exact retained home snapshot', async () => {
    const revision = 11;
    const snapshot = {
      account: memberAccount,
      publisherNamespaceId: memberNs,
      profileNamespaceId: 0,
      profileRev: revision,
      displayName: 'Exact source snapshot',
    };
    await database.db.insert(profileTable).values([
      snapshot,
      {
        ...snapshot,
        publisherNamespaceId: 0,
        displayName: 'Unrelated local snapshot',
      },
      {
        ...snapshot,
        publisherNamespaceId: signerNs,
        displayName: 'Unrelated peer snapshot',
      },
    ]);
    await database.db.insert(message).values(
      withMessageDigest({
        threadId,
        seq: 2,
        originSeq: 2,
        creatorAccount: memberAccount,
        publisherNamespaceId: memberNs,
        profileNamespaceId: 0,
        profileRev: revision,
        contentType: 'PURE_TEXT',
        content: JSON.stringify({ text: 'publisher-scoped author' }),
        updatedAt: new Date(),
      }),
    );
    const exact = () =>
      service.getAuthorizedGroupMemberProfile(
        groupName,
        memberAccount,
        memberNs,
        revision,
        signerNs,
      );
    const head = and(
      eq(peerStateFeed.namespaceId, signerNs),
      eq(peerStateFeed.account, groupName),
    );
    expect(await exact()).toBeNull();
    await database.db
      .update(peerStateFeed)
      .set({ body: { messageEndSeq: 2, tombstoneEndSeq: 0 } })
      .where(head);
    expect(
      await service.getAuthorizedGroupMemberProfile(
        groupName,
        memberAccount,
        0,
        revision,
        signerNs,
      ),
    ).toBeNull();
    expect(await exact()).toMatchObject({
      namespaceId: memberNs,
      account: memberAccount,
      profileRev: revision,
      displayName: snapshot.displayName,
    });
    await database.db.insert(threadAudience).values({
      threadId,
      targetNamespaceId: signerNs,
      messageAccessAfterSeq: 2,
    });
    expect(await exact()).toBeNull();
    await database.db
      .delete(threadAudience)
      .where(eq(threadAudience.threadId, threadId));
    await database.db
      .delete(profileTable)
      .where(
        and(
          eq(profileTable.publisherNamespaceId, memberNs),
          eq(profileTable.profileNamespaceId, 0),
          eq(profileTable.account, memberAccount),
          eq(profileTable.profileRev, revision),
        ),
      );
    // Cached snapshots with identical subject coordinates from other publishers
    // are not substitutes for the snapshot named by the authorized message.
    expect(await exact()).toBeNull();
    await database.db.insert(profileTable).values(snapshot);
    await database.db
      .update(message)
      .set({ isDeleted: true })
      .where(and(eq(message.threadId, threadId), eq(message.seq, 2)));
    expect(await exact()).toBeNull();
    await database.db
      .update(message)
      .set({ isDeleted: false })
      .where(and(eq(message.threadId, threadId), eq(message.seq, 2)));
    expect(await exact()).toMatchObject({ displayName: snapshot.displayName });
  });

  it('withdraws both proofs on revocation and does not substitute another revision', async () => {
    await database.db
      .update(relationshipIntent)
      .set({ status: 'REVOKED' })
      .where(
        and(
          eq(relationshipIntent.authorAccount, groupName),
          eq(relationshipIntent.authorNamespaceId, 0),
          eq(relationshipIntent.receiverAccount, signerAccount),
          eq(relationshipIntent.receiverNamespaceId, signerNs),
        ),
      );
    expect(await lookup(4)).toBeNull();
    expect(await lookup(7)).toBeNull();
    expect(await lookup(8)).toBeNull();
    expect(
      await service.getAuthorizedGroupMemberProfile(
        groupName,
        memberAccount,
        memberNs,
        11,
        signerNs,
      ),
    ).toBeNull();
  });
});
