import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test, type TestingModule } from '@nestjs/testing';
import { DatabaseModule } from '../src/database/database.module.js';
import { DatabaseService } from '../src/database/database.service.js';
import {
  accountThreadState,
  groupMeta,
  groupMetaMemberFeed,
  identityNamespace,
  message,
  messageThread,
  profileTable,
  relationshipPair,
  account as user,
} from '../src/database/schema.js';
import { GroupRole, MessageThreadType } from '../src/database/enums.js';
import { MessageService } from '../src/message/message.service.js';
import { mergeMirrorGroupMetaTargetInTx } from '../src/group/meta/merge-mirror-meta-target-in-tx.js';
import {
  applyDeltaMirrorMetaItemInTx,
  finalizeDeltaMirrorMetaRoundInTx,
} from '../src/group/meta/apply-delta-mirror-meta-item-in-tx.js';
import { applyFullMirrorMetaBatchInTx } from '../src/group/meta/apply-full-mirror-meta-batch-in-tx.js';
import {
  applyMirrorMetaFactInTx,
  reopenMirrorMetaRecoveryInTx,
  type MirrorGroupAddress,
  type MirrorMetaReplicatedItem,
} from '../src/group/meta/mirror-meta-shared.js';
import { seedFederatedPeerNamespace } from './seed.js';
import { readCurrentGroupRosterInTx } from '../src/group/meta/current-group-roster.js';
import { readGroupMetaPageInTx } from '../src/group/meta/group-meta-page.js';

describe('mirror Group Meta rounds', () => {
  const suffix = Date.now().toString(36);
  const originDomain = `mirror-round-${suffix}.test`;
  const groupAccount = `!mirrorround${suffix}`;
  const localMemberAccount = `local-${suffix}`;
  let module: TestingModule;
  let database: DatabaseService;
  let messages: MessageService;
  let originNamespaceId: number;
  let threadId: number;
  let localUserId: number;
  const group: MirrorGroupAddress = {
    account: groupAccount,
    domain: originDomain,
    namespaceId: 0,
  };

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    database = module.get(DatabaseService);
    messages = new MessageService(database, {} as never, {} as never);
    originNamespaceId = await seedFederatedPeerNamespace(
      database.db,
      originDomain,
    );
    group.namespaceId = originNamespaceId;

    const [member] = await database.db
      .insert(user)
      .values({
        account: localMemberAccount,
        defaultProfileRev: 1,
        availability: 'AVAILABLE',
      })
      .returning();
    localUserId = member.id;
    await database.db.insert(profileTable).values({
      account: localMemberAccount,
      domain: 'local',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 1,
      displayName: 'Local member',
    });
    const [thread] = await database.db
      .insert(messageThread)
      .values({
        type: MessageThreadType.GROUP,
        groupAccount,
        groupDomain: originDomain,
        authorityNamespaceId: originNamespaceId,
        federationRoundsEnabled: true,
        updatedAt: new Date(),
      })
      .returning();
    threadId = thread.id;
    // The local member watches the mirror through an active membership pair;
    // third-party transitions notify the current local authorized roster.
    await database.db.insert(relationshipPair).values({
      kind: 'GROUP_MEMBER',
      endpointAType: 'USER',
      endpointAAccount: localMemberAccount,
      endpointANamespaceId: 0,
      endpointBType: 'GROUP',
      endpointBAccount: groupAccount,
      endpointBNamespaceId: originNamespaceId,
      threadId,
      active: true,
      established: true,
      updatedAt: new Date(),
    });
    await database.db.insert(accountThreadState).values({
      accountId: localUserId,
      threadId,
      role: GroupRole.MEMBER,
      updatedAt: new Date(),
    });
  });

  beforeEach(async () => {
    await database.db.delete(message).where(eq(message.threadId, threadId));
    await database.db
      .delete(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.threadId, threadId));
    await database.db.delete(groupMeta).where(eq(groupMeta.threadId, threadId));
    await database.db
      .update(messageThread)
      .set({ groupDissolvedAt: null })
      .where(eq(messageThread.id, threadId));
  });

  afterAll(async () => {
    await database.db.delete(message).where(eq(message.threadId, threadId));
    await database.db
      .delete(accountThreadState)
      .where(eq(accountThreadState.threadId, threadId));
    await database.db
      .delete(relationshipPair)
      .where(eq(relationshipPair.threadId, threadId));
    await database.db
      .delete(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.threadId, threadId));
    await database.db.delete(groupMeta).where(eq(groupMeta.threadId, threadId));
    await database.db
      .delete(messageThread)
      .where(eq(messageThread.id, threadId));
    await database.db.delete(user).where(eq(user.id, localUserId));
    await database.db
      .update(identityNamespace)
      .set({ active: false })
      .where(eq(identityNamespace.domain, originDomain));
    await module.close();
  });

  const memberUpsert = (
    feedId: number,
    memberAccount: string,
    role = 'MEMBER',
  ): MirrorMetaReplicatedItem => ({
    feedId,
    operation: 'MEMBER_UPSERT',
    account: memberAccount,
    domain: originDomain,
    role: role as 'MEMBER',
    profileRev: 1,
  });

  const memberDepart = (feedId: number, memberAccount: string) =>
    ({
      feedId,
      operation: 'MEMBER_DEPART',
      account: memberAccount,
      domain: originDomain,
    }) as MirrorMetaReplicatedItem;

  const roster = async () =>
    (
      await database.db
        .select({
          feedId: groupMetaMemberFeed.feedId,
          memberAccount: groupMetaMemberFeed.memberAccount,
          memberDomain: groupMetaMemberFeed.memberDomain,
          operation: groupMetaMemberFeed.operation,
          body: groupMetaMemberFeed.body,
        })
        .from(groupMetaMemberFeed)
        .where(eq(groupMetaMemberFeed.threadId, threadId))
    ).sort((left, right) => left.feedId - right.feedId);

  const readMirrorMeta = () =>
    database.db.query.groupMeta.findFirst({
      where: eq(groupMeta.threadId, threadId),
    });

  it('opens a recovery window at the merged target when the cursor row is absent', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 9 }),
    );
    expect(await readMirrorMeta()).toMatchObject({
      threadId,
      metaTargetId: 9,
      metaProcessedThroughId: 0,
      metaRecoveryThroughId: 9,
    });
  });

  it('greatest-merges targets and re-fixes an open window only at a zero cursor', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 5 }),
    );
    // A cursor already past zero keeps the running window (a live drain) and
    // only the target moves forward.
    await database.db
      .update(groupMeta)
      .set({ metaProcessedThroughId: 2 })
      .where(eq(groupMeta.threadId, threadId));
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 3 }),
    );
    expect(await readMirrorMeta()).toMatchObject({
      metaTargetId: 5,
      metaProcessedThroughId: 2,
      metaRecoveryThroughId: 5,
    });
  });

  it('commits a complete full drain atomically and emits no system messages', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 9 }),
    );
    await database.db.insert(groupMetaMemberFeed).values({
      threadId,
      feedId: 1,
      memberAccount: 'stale-member',
      memberDomain: originDomain,
      operation: 'MEMBER_UPSERT',
      body: { role: 'MEMBER', profileRev: 1 },
    });
    const items: MirrorMetaReplicatedItem[] = [
      memberUpsert(2, 'peer-one', 'OWNER'),
      memberUpsert(3, 'peer-two'),
      memberUpsert(5, 'peer-three'),
      { feedId: 9, operation: 'GROUP_PROFILE', profileRev: 4 },
    ];
    await expect(
      database.db.transaction((tx) =>
        applyFullMirrorMetaBatchInTx(tx, {
          group,
          items: items.slice(0, 2),
          through: 9,
          scannedThrough: 3,
          reachedBoundary: false,
        }),
      ),
    ).rejects.toThrow('complete fixed-through drain');
    expect((await roster()).map((row) => row.memberAccount)).toEqual([
      'stale-member',
    ]);
    expect(await readMirrorMeta()).toMatchObject({
      metaProcessedThroughId: 0,
      metaRecoveryThroughId: 9,
    });
    await database.db.transaction((tx) =>
      applyFullMirrorMetaBatchInTx(tx, {
        group,
        items,
        through: 9,
        scannedThrough: 9,
        reachedBoundary: true,
      }),
    );
    expect(await readMirrorMeta()).toMatchObject({
      metaEndId: 9,
      metaTargetId: 9,
      metaProcessedThroughId: 9,
      metaRecoveryThroughId: null,
    });
    // Group Meta commits only version references, even before profile content exists.
    expect(
      await database.db.query.profileTable.findFirst({
        where: and(
          eq(profileTable.account, groupAccount),
          eq(profileTable.profileRev, 4),
        ),
      }),
    ).toBeUndefined();
    const rows = await roster();
    expect(
      rows.find((row) => row.memberAccount === 'stale-member'),
    ).toBeUndefined();
    expect(
      rows.filter((row) => row.operation === 'MEMBER_UPSERT'),
    ).toHaveLength(3);
    // A mirror must expose the same active roster cardinality as the
    // authority after the complete Group Meta drain, including the remote
    // owner. This is the server-side contract consumed by the client mirror.
    await expect(
      database.db.transaction((tx) => readCurrentGroupRosterInTx(tx, threadId)),
    ).resolves.toHaveLength(3);
    expect(rows.find((row) => row.operation === 'GROUP_PROFILE')).toMatchObject(
      {
        feedId: 9,
        memberAccount: groupAccount,
        memberDomain: originDomain,
        body: { profileRev: 4 },
      },
    );
    expect(
      await database.db
        .select({ id: message.id })
        .from(message)
        .where(eq(message.threadId, threadId)),
    ).toEqual([]);
  });

  it('rejects full batches when the window closed or changed mid-drain', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 9 }),
    );
    await expect(
      database.db.transaction((tx) =>
        applyFullMirrorMetaBatchInTx(tx, {
          group,
          items: [],
          through: 5,
          scannedThrough: 0,
          reachedBoundary: false,
        }),
      ),
    ).rejects.toThrow('changed');

    await database.db
      .update(groupMeta)
      .set({ metaRecoveryThroughId: 9 })
      .where(eq(groupMeta.threadId, threadId));
    await database.db
      .update(groupMeta)
      .set({ metaRecoveryThroughId: null })
      .where(eq(groupMeta.threadId, threadId));
    await expect(
      database.db.transaction((tx) =>
        applyFullMirrorMetaBatchInTx(tx, {
          group,
          items: [],
          through: 9,
          scannedThrough: 0,
          reachedBoundary: false,
        }),
      ),
    ).rejects.toThrow('closed');
  });

  it('drains delta items one per transaction: third-party transitions mint system messages, the cursor advances per item', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 8 }),
    );
    await database.db
      .update(groupMeta)
      .set({ metaRecoveryThroughId: null })
      .where(eq(groupMeta.threadId, threadId));

    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: memberUpsert(2, 'peer-one'),
        through: 8,
        reachedBoundary: false,
        messages,
      }),
    );
    expect(
      await database.db
        .select({ cursor: groupMeta.metaProcessedThroughId })
        .from(groupMeta)
        .where(eq(groupMeta.threadId, threadId)),
    ).toMatchObject([{ cursor: 2 }]);
    const joined = await database.db
      .select({ content: message.content })
      .from(message)
      .where(eq(message.threadId, threadId));
    expect(joined.length).toBe(1);
    expect(JSON.parse(joined[0]!.content as string)).toMatchObject({
      type: 'GROUP_JOINED',
      member: {
        account: 'peer-one',
        domain: originDomain,
        namespaceId: originNamespaceId,
        profileRev: 1,
      },
    });

    // A rejoin boundary (MEMBER_DEPART after MEMBER_UPSERT) mints the leave message.
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: memberDepart(4, 'peer-one'),
        through: 8,
        reachedBoundary: false,
        messages,
      }),
    );
    const transitions = await database.db
      .select({ content: message.content })
      .from(message)
      .where(eq(message.threadId, threadId));
    expect(
      transitions.map((row) => JSON.parse(row.content as string).type),
    ).toEqual(['GROUP_JOINED', 'GROUP_LEFT']);
    expect(JSON.parse(transitions[1]!.content as string).member).toMatchObject({
      account: 'peer-one',
      domain: originDomain,
      namespaceId: originNamespaceId,
      profileRev: 1,
    });
    expect(
      await database.db
        .select({ cursor: groupMeta.metaProcessedThroughId })
        .from(groupMeta)
        .where(eq(groupMeta.threadId, threadId)),
    ).toMatchObject([{ cursor: 4 }]);

    // A GROUP_PROFILE item mints no message but still advances the cursor.
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: { feedId: 5, operation: 'GROUP_PROFILE', profileRev: 7 },
        through: 8,
        reachedBoundary: false,
        messages,
      }),
    );
    expect(
      await database.db
        .select({ cursor: groupMeta.metaProcessedThroughId })
        .from(groupMeta)
        .where(eq(groupMeta.threadId, threadId)),
    ).toMatchObject([{ cursor: 5 }]);
    expect(
      (
        await database.db
          .select({ content: message.content })
          .from(message)
          .where(eq(message.threadId, threadId))
      ).length,
    ).toBe(2);

    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: memberUpsert(8, 'peer-two', 'OWNER'),
        through: 8,
        reachedBoundary: true,
        messages,
      }),
    );
    expect(await readMirrorMeta()).toMatchObject({
      metaEndId: 8,
      metaProcessedThroughId: 8,
      metaRecoveryThroughId: null,
    });
  });

  it('emits no system messages when a full drain restores a previously departed member', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 8 }),
    );
    await database.db
      .update(groupMeta)
      .set({ metaRecoveryThroughId: null })
      .where(eq(groupMeta.threadId, threadId));

    // Live delta observation: the member joins and later departs, leaving a
    // MEMBER_DEPART tombstone in the replica and both boundary messages.
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: memberUpsert(2, 'peer-one'),
        through: 8,
        reachedBoundary: false,
        messages,
      }),
    );
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: memberDepart(4, 'peer-one'),
        through: 8,
        reachedBoundary: false,
        messages,
      }),
    );

    // The origin compacted below the delta cursor, so the mirror re-opens a
    // recovery drain; the full snapshot carries the member's rejoin.
    await database.db.transaction((tx) =>
      reopenMirrorMetaRecoveryInTx(tx, group, 8),
    );
    await database.db.transaction((tx) =>
      applyFullMirrorMetaBatchInTx(tx, {
        group,
        items: [memberUpsert(5, 'peer-one')],
        through: 8,
        scannedThrough: 8,
        reachedBoundary: true,
      }),
    );

    const transitions = (
      await database.db
        .select({ content: message.content })
        .from(message)
        .where(eq(message.threadId, threadId))
    ).map((row) => JSON.parse(row.content as string).type);
    expect(transitions).toEqual(['GROUP_JOINED', 'GROUP_LEFT']);
    expect(await roster()).toEqual([
      expect.objectContaining({
        memberAccount: 'peer-one',
        operation: 'MEMBER_UPSERT',
      }),
    ]);
  });

  it('closes an empty final delta page without facts', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 3 }),
    );
    await database.db
      .update(groupMeta)
      .set({ metaRecoveryThroughId: null })
      .where(eq(groupMeta.threadId, threadId));
    await database.db.transaction((tx) =>
      finalizeDeltaMirrorMetaRoundInTx(tx, {
        group,
        through: 3,
      }),
    );
    expect(await readMirrorMeta()).toMatchObject({
      metaEndId: 3,
      metaProcessedThroughId: 3,
      metaRecoveryThroughId: null,
    });
  });

  it('keeps a clipped empty roster live while a local membership pair remains active', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 2 }),
    );
    await database.db
      .update(groupMeta)
      .set({ metaRecoveryThroughId: null })
      .where(eq(groupMeta.threadId, threadId));
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: memberUpsert(1, 'peer-one'),
        through: 2,
        reachedBoundary: false,
        messages,
      }),
    );
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: memberDepart(2, 'peer-one'),
        through: 2,
        reachedBoundary: true,
        messages,
      }),
    );
    const [thread] = await database.db
      .select({ dissolvedAt: messageThread.groupDissolvedAt })
      .from(messageThread)
      .where(eq(messageThread.id, threadId));
    expect(thread!.dissolvedAt).toBeNull();
    await database.db
      .update(relationshipPair)
      .set({ active: false })
      .where(eq(relationshipPair.threadId, threadId));
    await database.db.transaction((tx) =>
      finalizeDeltaMirrorMetaRoundInTx(tx, {
        group,
        through: 2,
      }),
    );
    const [revokedThread] = await database.db
      .select({ dissolvedAt: messageThread.groupDissolvedAt })
      .from(messageThread)
      .where(eq(messageThread.id, threadId));
    expect(revokedThread!.dissolvedAt).not.toBeNull();
    await database.db
      .update(relationshipPair)
      .set({ active: true })
      .where(eq(relationshipPair.threadId, threadId));
  });

  it('re-opens the recovery window at the current target', async () => {
    // A zero cursor may still need a newer full boundary.
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 4 }),
    );
    await database.db.transaction((tx) =>
      reopenMirrorMetaRecoveryInTx(tx, group),
    );
    expect(await readMirrorMeta()).toMatchObject({
      metaProcessedThroughId: 0,
      metaRecoveryThroughId: 4,
    });

    await database.db
      .update(groupMeta)
      .set({ metaProcessedThroughId: 2, metaRecoveryThroughId: null })
      .where(eq(groupMeta.threadId, threadId));
    await database.db.transaction((tx) =>
      reopenMirrorMetaRecoveryInTx(tx, group),
    );
    expect(await readMirrorMeta()).toMatchObject({
      metaProcessedThroughId: 0,
      metaRecoveryThroughId: 4,
    });
  });

  it('applies announcement full, delta clear and clipped-full unknown atomically', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 2 }),
    );
    await database.db.transaction((tx) =>
      applyFullMirrorMetaBatchInTx(tx, {
        group,
        through: 2,
        scannedThrough: 2,
        reachedBoundary: true,
        items: [{ feedId: 2, operation: 'GROUP_ANNOUNCEMENT', text: 'Hello' }],
      }),
    );
    expect(await readMirrorMeta()).toMatchObject({
      announcementFeedId: 2,
      announcementText: 'Hello',
    });
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 3 }),
    );
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        through: 3,
        reachedBoundary: true,
        messages,
        item: { feedId: 3, operation: 'GROUP_ANNOUNCEMENT', text: null },
      }),
    );
    expect(await readMirrorMeta()).toMatchObject({
      announcementFeedId: 3,
      announcementText: null,
    });
    await database.db.transaction((tx) =>
      reopenMirrorMetaRecoveryInTx(tx, group, 4),
    );
    await database.db.transaction((tx) =>
      applyFullMirrorMetaBatchInTx(tx, {
        group,
        through: 4,
        scannedThrough: 4,
        reachedBoundary: true,
        items: [],
      }),
    );
    expect(await readMirrorMeta()).toMatchObject({
      announcementFeedId: null,
      announcementText: null,
    });
  });

  it('upserts the same stable profile key in full and delta modes', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 2 }),
    );
    const profileItem: MirrorMetaReplicatedItem = {
      feedId: 2,
      operation: 'GROUP_PROFILE',
      profileRev: 3,
    };
    await database.db.transaction((tx) =>
      applyMirrorMetaFactInTx(tx, threadId, group, profileItem, 'full'),
    );
    await database.db.transaction((tx) =>
      applyMirrorMetaFactInTx(tx, threadId, group, profileItem, 'full'),
    );
    expect(
      (await roster()).filter((row) => row.operation === 'GROUP_PROFILE'),
    ).toHaveLength(1);
    expect(
      await database.db
        .select({ profileRev: groupMeta.profileRev })
        .from(groupMeta)
        .where(eq(groupMeta.threadId, threadId)),
    ).toMatchObject([{ profileRev: 3 }]);

    await database.db.transaction((tx) =>
      applyMirrorMetaFactInTx(
        tx,
        threadId,
        group,
        { feedId: 2, operation: 'GROUP_PROFILE', profileRev: 4 },
        'full',
      ),
    );
    expect(
      (await roster()).filter((row) => row.operation === 'GROUP_PROFILE'),
    ).toMatchObject([{ feedId: 2, body: { profileRev: 4 } }]);

    await database.db.transaction((tx) =>
      applyMirrorMetaFactInTx(
        tx,
        threadId,
        group,
        { feedId: 3, operation: 'GROUP_PROFILE', profileRev: 5 },
        'delta',
      ),
    );
    expect(
      (await roster()).filter((row) => row.operation === 'GROUP_PROFILE'),
    ).toMatchObject([{ feedId: 3, body: { profileRev: 5 } }]);
    // A different stable key cannot reuse the current coordinate.
    await expect(
      database.db.transaction((tx) =>
        applyMirrorMetaFactInTx(
          tx,
          threadId,
          group,
          memberUpsert(3, 'peer-one'),
          'delta',
        ),
      ),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
  });

  it('aborts a repeated delta item without advancing its cursor or replaying a notice', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 1 }),
    );
    await database.db
      .update(groupMeta)
      .set({ metaRecoveryThroughId: null })
      .where(eq(groupMeta.threadId, threadId));
    const input = {
      group,
      item: memberUpsert(1, 'peer-replay'),
      through: 1,
      reachedBoundary: false,
      messages,
    };
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, input),
    );
    const before = await database.db
      .select({ cursor: groupMeta.metaProcessedThroughId })
      .from(groupMeta)
      .where(eq(groupMeta.threadId, threadId));
    const noticesBefore = await database.db
      .select({ id: message.id })
      .from(message)
      .where(eq(message.threadId, threadId));

    await expect(
      database.db.transaction((tx) => applyDeltaMirrorMetaItemInTx(tx, input)),
    ).rejects.toThrow('duplicate or stale group-meta delta coordinate');
    expect(
      await database.db
        .select({ cursor: groupMeta.metaProcessedThroughId })
        .from(groupMeta)
        .where(eq(groupMeta.threadId, threadId)),
    ).toEqual(before);
    expect(
      await database.db
        .select({ id: message.id })
        .from(message)
        .where(eq(message.threadId, threadId)),
    ).toEqual(noticesBefore);
  });

  it('announces local delta joins and departures only when the pair agrees', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 5 }),
    );
    await database.db
      .update(groupMeta)
      .set({ metaRecoveryThroughId: null })
      .where(eq(groupMeta.threadId, threadId));
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: {
          feedId: 1,
          operation: 'MEMBER_UPSERT',
          account: localMemberAccount,
          domain: 'local',
          role: 'MEMBER',
          profileRev: 1,
        },
        through: 5,
        reachedBoundary: false,
        messages,
      }),
    );
    const joined = await database.db
      .select({ content: message.content })
      .from(message)
      .where(eq(message.threadId, threadId));
    expect(joined).toHaveLength(1);
    expect(JSON.parse(joined[0]!.content as string)).toMatchObject({
      type: 'GROUP_JOINED',
      member: { account: localMemberAccount, domain: 'local' },
    });
    for (const [feedId, operation] of [
      [2, 'MEMBER_UPSERT'],
      [3, 'MEMBER_DEPART'],
    ] as const) {
      await database.db.transaction((tx) =>
        applyDeltaMirrorMetaItemInTx(tx, {
          group,
          item: {
            feedId,
            operation,
            account: localMemberAccount,
            domain: 'local',
            ...(operation === 'MEMBER_UPSERT'
              ? { role: 'MEMBER' as const, profileRev: 1 }
              : {}),
          },
          through: 5,
          reachedBoundary: false,
          messages,
        }),
      );
    }
    expect(
      await database.db
        .select({ id: message.id })
        .from(message)
        .where(eq(message.threadId, threadId)),
    ).toHaveLength(1);
    // The departure stays as a tombstone at its coordinate: mirror feeds
    // share the origin's coordinate space, and deleting the row would hide
    // the departure from delta readers.
    const retainedFacts = await database.db
      .select({
        feedId: groupMetaMemberFeed.feedId,
        operation: groupMetaMemberFeed.operation,
      })
      .from(groupMetaMemberFeed)
      .where(eq(groupMetaMemberFeed.threadId, threadId));
    expect(retainedFacts).toEqual([
      expect.objectContaining({ operation: 'MEMBER_DEPART' }),
    ]);
    await database.db
      .update(relationshipPair)
      .set({ active: false, established: true })
      .where(eq(relationshipPair.threadId, threadId));
    // A stale MEMBER_DEPART while the pair remained active was ignored. A later
    // activated pair permits the next MEMBER_UPSERT to announce re-entry.
    await database.db
      .update(relationshipPair)
      .set({ active: true })
      .where(eq(relationshipPair.threadId, threadId));
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: {
          feedId: 4,
          operation: 'MEMBER_UPSERT',
          account: localMemberAccount,
          domain: 'local',
          role: 'MEMBER',
          profileRev: 2,
        },
        through: 5,
        reachedBoundary: false,
        messages,
      }),
    );
    expect(
      await database.db
        .select({ id: message.id })
        .from(message)
        .where(eq(message.threadId, threadId)),
    ).toHaveLength(2);
    await database.db
      .update(relationshipPair)
      .set({ active: false })
      .where(eq(relationshipPair.threadId, threadId));
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: {
          feedId: 5,
          operation: 'MEMBER_DEPART',
          account: localMemberAccount,
          domain: 'local',
        },
        through: 5,
        reachedBoundary: false,
        messages,
      }),
    );
    const notices = await database.db
      .select({ content: message.content })
      .from(message)
      .where(eq(message.threadId, threadId));
    // The local REVOKED intent owns GROUP_LEFT; a later Meta MEMBER_DEPART only
    // removes its replicated fact and must not announce it twice.
    expect(
      notices.map((row) => JSON.parse(row.content as string).type),
    ).toEqual(['GROUP_JOINED', 'GROUP_JOINED']);
  });

  it('retains a MEMBER_DEPART tombstone so later delta pages carry the departure', async () => {
    await database.db.transaction((tx) =>
      mergeMirrorGroupMetaTargetInTx(tx, { group, metaTargetId: 41 }),
    );
    await database.db
      .update(groupMeta)
      .set({ metaRecoveryThroughId: null })
      .where(eq(groupMeta.threadId, threadId));
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: memberUpsert(40, 'peer-tombstone'),
        through: 40,
        reachedBoundary: false,
        messages,
      }),
    );
    await database.db.transaction((tx) =>
      applyDeltaMirrorMetaItemInTx(tx, {
        group,
        item: memberDepart(41, 'peer-tombstone'),
        through: 41,
        reachedBoundary: false,
        messages,
      }),
    );
    const facts = await database.db
      .select({
        feedId: groupMetaMemberFeed.feedId,
        operation: groupMetaMemberFeed.operation,
      })
      .from(groupMetaMemberFeed)
      .where(
        and(
          eq(groupMetaMemberFeed.threadId, threadId),
          eq(groupMetaMemberFeed.memberAccount, 'peer-tombstone'),
        ),
      );
    expect(facts).toEqual([{ feedId: 41, operation: 'MEMBER_DEPART' }]);
    await database.db.transaction((tx) =>
      finalizeDeltaMirrorMetaRoundInTx(tx, {
        group,
        through: 41,
      }),
    );
    const [head] = await database.db
      .select({ end: groupMeta.metaEndId })
      .from(groupMeta)
      .where(eq(groupMeta.threadId, threadId));
    const page = await database.db.transaction((tx) =>
      readGroupMetaPageInTx(tx, {
        groupId: threadId,
        account: groupAccount,
        viewMode: 'federation',
        feedMode: 'delta',
        after: 40,
        take: 100,
        end: head.end,
        visibleAfter: 0,
      }),
    );
    expect(page.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          operation: 'MEMBER_DEPART',
          account: 'peer-tombstone',
        }),
      ]),
    );
    const roster = await database.db.transaction((tx) =>
      readCurrentGroupRosterInTx(tx, threadId),
    );
    expect(roster.some((row) => row.account === 'peer-tombstone')).toBe(false);
  });
});
