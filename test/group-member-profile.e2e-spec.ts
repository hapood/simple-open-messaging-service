import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
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
  let database: DatabaseService;
  let service: FederationProfileService;
  let signerNs: number;
  let memberNs: number;
  let groupId: number;
  let threadId: number;
  let pairIds: bigint[];

  const lookup = (rev: number, domain = signerDomain, namespace = signerNs) =>
    service.getAuthorizedGroupMemberProfile(
      groupName,
      memberDomain,
      memberAccount,
      rev,
      domain,
      namespace,
    );

  beforeAll(async () => {
    database = new DatabaseService();
    service = new FederationProfileService(database, {} as never, {} as never);
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
        groupDomain: 'local',
        groupAccountId: groupId,
        updatedAt: new Date(),
      })
      .returning({ id: messageThread.id });
    threadId = thread.id;
    await database.db.insert(groupMeta).values({ threadId, metaEndId: 1 });
    await database.db.insert(groupMetaMemberFeed).values({
      threadId,
      feedId: 1,
      memberAccount,
      memberDomain,
      operation: 'MEMBER_UPSERT',
      body: { role: 'MEMBER', profileRev: 4 },
      updatedAt: new Date(),
    });
    await database.db.insert(profileTable).values([
      {
        account: memberAccount,
        domain: memberDomain,
        publisherNamespaceId: memberNs,
        profileNamespaceId: memberNs,
        profileRev: 4,
        displayName: 'Old snapshot',
      },
      {
        account: memberAccount,
        domain: memberDomain,
        publisherNamespaceId: memberNs,
        profileNamespaceId: memberNs,
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
      peerDomain: signerDomain,
      namespaceId: signerNs,
      account: groupName,
      domain: localDomain,
      eventType: 'THREAD_CONTENT_HEAD',
      feedId: 1n,
      body: { messageEndSeq: 0 },
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
      .where(
        and(
          eq(profileTable.account, memberAccount),
          eq(profileTable.domain, memberDomain),
        ),
      );
    await database.onApplicationShutdown();
  });

  it('serves exactly the current member reference to a current group audience', async () => {
    expect(await lookup(4)).toMatchObject({
      account: memberAccount,
      domain: memberDomain,
      profileRev: 4,
      displayName: 'Old snapshot',
    });
    expect(await lookup(7)).toBeNull();
    expect(await lookup(0)).toBeNull();
    expect(await lookup(4, memberDomain, memberNs)).toBeNull();
  });

  it('serves a distinct message revision only inside the published interval', async () => {
    await database.db.insert(message).values({
      threadId,
      seq: 1,
      profileRev: 7,
      creatorAccount: memberAccount,
      creatorDomain: memberDomain,
      profileNamespaceId: memberNs,
      contentType: 'PURE_TEXT',
      content: JSON.stringify({ text: 'hello' }),
      updatedAt: new Date(),
    });
    expect(await lookup(7)).toBeNull();
    await database.db
      .update(peerStateFeed)
      .set({
        body: { messageEndSeq: 1 },
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
      targetDomain: signerDomain,
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
      .update(groupMetaMemberFeed)
      .set({
        feedId: 2,
        operation: 'MEMBER_DEPART',
        body: {},
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
  });
});
