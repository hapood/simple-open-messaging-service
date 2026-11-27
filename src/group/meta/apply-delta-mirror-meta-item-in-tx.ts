import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { MessageService } from '../../message/message.service.js';
import { SystemMessageType } from '../../message/system-message.js';
import { enqueueThreadFanoutInTx } from '../../message/thread-fanout-task.js';
import { reconcileClientMemberCountInTx } from './reconcile-client-member-count-in-tx.js';
import { readCurrentLocalAuthorizedGroupMemberIdsInTx } from './current-group-roster.js';
import { requireGroupThreadContentLockUnderGroupInTx } from '../../common/locks/thread-content-lock.js';
import type { ProfilePrefetchDemand } from '../../profile-resolution/profile-resolution-demand.js';
import { collectCommittedProfileWork } from '../../message/collect-committed-profile-work.js';
import { groupMemberProfileAddress } from './group-member-profile-address.js';
import type { MessageProfileWorkCommittedEvent } from '../../message/message-profile-work.event.js';
import { selectMirrorMetaProfileDemand } from './select-mirror-meta-profile-demand.js';
import type {
  MirrorGroupAddress,
  MirrorMetaReplicatedItem,
} from './mirror-meta-shared.js';
import {
  advanceMirrorProcessedThroughInTx,
  applyMirrorMetaFactInTx,
  finalizeMirrorMetaRecoveryInTx,
  lockMirrorGroupInTx,
  requireMirrorMetaInTx,
} from './mirror-meta-shared.js';

export interface DeltaMirrorMetaItemInput {
  group: MirrorGroupAddress;
  item: MirrorMetaReplicatedItem;
  /** The round's fixed target; the scan cursor is fenced against it. */
  through: number;
  /** True for the round's last item: the applied end advances to `through`
   * and the shell projection refreshes in this same transaction. */
  reachedBoundary: boolean;
  messages: Pick<MessageService, 'writeSystemMessageInTx'>;
}

export interface DeltaMirrorMetaPageInput {
  group: MirrorGroupAddress;
  items: readonly MirrorMetaReplicatedItem[];
  /** The round's fixed target; the scan cursor is fenced against it. */
  through: number;
  /** The fetched page's scanned-through; used when items is empty. */
  scannedThrough: number;
  /** True for the round's last page: the applied end advances to `through`
   * and the shell projection refreshes in this same transaction. */
  reachedBoundary: boolean;
  messages: Pick<MessageService, 'writeSystemMessageInTx'>;
}

/** Delta Group Meta consumption: one fetched page per transaction. Replica
 * facts apply idempotently, member count is reconciled once at the end of the
 * page, and the scan cursor advances to the last item's feed id. */
export async function applyDeltaMirrorMetaPageInTx(
  tx: DatabaseTransaction,
  input: DeltaMirrorMetaPageInput,
): Promise<{
  threadId: number;
  profileDemands: ProfilePrefetchDemand[];
  systemMessageProfileWorks: MessageProfileWorkCommittedEvent[];
}> {
  await lockMirrorGroupInTx(tx, input.group);
  const mirror = await requireMirrorMetaInTx(tx, input.group);
  if (mirror.metaRecoveryThroughId !== 0)
    throw new Error('a meta recovery drain opened during this delta round');
  const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
    tx,
    mirror.threadId,
    mirror.threadId,
  );
  let lastFeedId = mirror.metaProcessedThroughId;
  let hasMembershipMutation = false;
  let hasGroupProfile = false;
  let anyTransitioned = false;
  const joinedMembers: ReturnType<typeof groupMemberProfileAddress>[] = [];
  const leftMembers: ReturnType<typeof groupMemberProfileAddress>[] = [];
  const profileDemands: ProfilePrefetchDemand[] = [];
  const systemMessageProfileWorks: MessageProfileWorkCommittedEvent[] = [];

  for (const item of input.items) {
    if (item.feedId <= lastFeedId)
      throw new Error('duplicate or stale group-meta delta coordinate');
    const previousFact = await readCurrentMirrorMemberOperationInTx(
      tx,
      mirror.threadId,
      item,
    );
    await applyMirrorMetaFactInTx(
      tx,
      mirror.threadId,
      input.group,
      item,
      'delta',
    );
    if (item.operation === 'MEMBER_UPSERT' || item.operation === 'MEMBER_DEPART')
      hasMembershipMutation = true;
    if (item.operation === 'GROUP_PROFILE') hasGroupProfile = true;
    const transition = await resolveObservedMembershipTransitionInTx(
      tx,
      mirror.threadId,
      input.group,
      item,
      previousFact,
    );
    if (transition) {
      if (transition.type === 'GROUP_JOINED') {
        joinedMembers.push(transition.memberAddress);
      } else {
        leftMembers.push(transition.memberAddress);
      }
    }
    const demand = selectChangedMirrorMemberProfileDemand(
      input.group,
      item,
      previousFact,
    );
    if (demand) profileDemands.push(demand);
    lastFeedId = item.feedId;
  }

  if (joinedMembers.length > 0) {
    anyTransitioned = true;
    const work = await writeBatchedMembershipSystemMessageInTx(
      tx,
      mirror.threadId,
      input.group,
      SystemMessageType.GROUP_JOINED,
      joinedMembers as [
        ReturnType<typeof groupMemberProfileAddress>,
        ...ReturnType<typeof groupMemberProfileAddress>[],
      ],
      { threadLock, messages: input.messages },
    );
    if (work) systemMessageProfileWorks.push(work);
  }
  if (leftMembers.length > 0) {
    anyTransitioned = true;
    const work = await writeBatchedMembershipSystemMessageInTx(
      tx,
      mirror.threadId,
      input.group,
      SystemMessageType.GROUP_LEFT,
      leftMembers as [
        ReturnType<typeof groupMemberProfileAddress>,
        ...ReturnType<typeof groupMemberProfileAddress>[],
      ],
      { threadLock, messages: input.messages },
    );
    if (work) systemMessageProfileWorks.push(work);
  }

  if (hasMembershipMutation) {
    await reconcileClientMemberCountInTx(tx, threadLock);
  }
  if (!anyTransitioned && hasGroupProfile) {
    const messageEnd = await tx.execute<{ head: number }>(sql`
      SELECT COALESCE(max(seq), 0)::integer AS head FROM "Message"
      WHERE "threadId" = ${mirror.threadId}`);
    await enqueueThreadFanoutInTx(tx, threadLock, {
      threadId: mirror.threadId,
      messageEndSeq: messageEnd.rows[0]!.head,
    });
  }
  const cursorTarget =
    input.items.length > 0 ? lastFeedId : input.scannedThrough;
  if (input.reachedBoundary) {
    await finalizeMirrorMetaRecoveryInTx(tx, {
      threadId: mirror.threadId,
      through: input.through,
      threadLock,
    });
  }
  await advanceMirrorProcessedThroughInTx(
    tx,
    mirror.threadId,
    cursorTarget,
    input.through,
  );
  return {
    threadId: mirror.threadId,
    profileDemands,
    systemMessageProfileWorks,
  };
}

/** Delta Group Meta consumption: one feed item per transaction. The replica
 * fact applies idempotently, a third-party join or leave transition writes its
 * system message (whose writer admits the local fan-out), an item without a
 * transition admits the same fan-out directly, and the scan cursor advances to
 * the item's feed id. Lock order: group Account State scope, Thread Content
 * lock, GroupMeta and roster facts. */
export async function applyDeltaMirrorMetaItemInTx(
  tx: DatabaseTransaction,
  input: DeltaMirrorMetaItemInput,
): Promise<{
  threadId: number;
  profileDemand: ProfilePrefetchDemand | null;
  systemMessageProfileWork?: MessageProfileWorkCommittedEvent;
}> {
  await lockMirrorGroupInTx(tx, input.group);
  const mirror = await requireMirrorMetaInTx(tx, input.group);
  if (mirror.metaRecoveryThroughId !== 0)
    throw new Error('a meta recovery drain opened during this delta round');
  const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
    tx,
    mirror.threadId,
    mirror.threadId,
  );
  if (input.item.feedId <= mirror.metaProcessedThroughId)
    throw new Error('duplicate or stale group-meta delta coordinate');
  const previousFact = await readCurrentMirrorMemberOperationInTx(
    tx,
    mirror.threadId,
    input.item,
  );
  await applyMirrorMetaFactInTx(
    tx,
    mirror.threadId,
    input.group,
    input.item,
    'delta',
  );
  if (
    input.item.operation === 'MEMBER_UPSERT' ||
    input.item.operation === 'MEMBER_DEPART'
  ) {
    await reconcileClientMemberCountInTx(tx, threadLock);
  }
  const transition = await resolveObservedMembershipTransitionInTx(
    tx,
    mirror.threadId,
    input.group,
    input.item,
    previousFact,
  );
  let transitioned = false;
  let profileWork: MessageProfileWorkCommittedEvent | undefined;
  if (transition) {
    transitioned = true;
    profileWork = await writeBatchedMembershipSystemMessageInTx(
      tx,
      mirror.threadId,
      input.group,
      transition.type,
      [transition.memberAddress],
      { threadLock, messages: input.messages },
    );
  }
  if (!transitioned && input.item.operation === 'GROUP_PROFILE') {
    const messageEnd = await tx.execute<{ head: number }>(sql`
      SELECT COALESCE(max(seq), 0)::integer AS head FROM "Message"
      WHERE "threadId" = ${mirror.threadId}`);
    await enqueueThreadFanoutInTx(tx, threadLock, {
      threadId: mirror.threadId,
      messageEndSeq: messageEnd.rows[0]!.head,
    });
  }
  if (input.reachedBoundary) {
    await finalizeMirrorMetaRecoveryInTx(tx, {
      threadId: mirror.threadId,
      through: input.through,
      threadLock,
    });
    await advanceMirrorProcessedThroughInTx(
      tx,
      mirror.threadId,
      input.item.feedId,
      input.through,
    );
    return {
      threadId: mirror.threadId,
      profileDemand: selectChangedMirrorMemberProfileDemand(
        input.group,
        input.item,
        previousFact,
      ),
      ...(profileWork ? { systemMessageProfileWork: profileWork } : {}),
    };
  }
  await advanceMirrorProcessedThroughInTx(
    tx,
    mirror.threadId,
    input.item.feedId,
    input.through,
  );
  return {
    threadId: mirror.threadId,
    profileDemand: selectChangedMirrorMemberProfileDemand(
      input.group,
      input.item,
      previousFact,
    ),
    ...(profileWork ? { systemMessageProfileWork: profileWork } : {}),
  };
}

function selectChangedMirrorMemberProfileDemand(
  group: DeltaMirrorMetaItemInput['group'],
  item: MirrorMetaReplicatedItem,
  previousFact:
    | {
        operation: string;
        namespaceId: number | null;
        profileRev: number | null;
      }
    | undefined,
): ProfilePrefetchDemand | null {
  if (
    item.operation === 'MEMBER_UPSERT' &&
    previousFact?.operation === 'MEMBER_UPSERT' &&
    previousFact.namespaceId === item.namespaceId &&
    previousFact.profileRev === item.profileRev
  )
    return null;
  return selectMirrorMetaProfileDemand(group, item);
}

/** Closes a delta round whose final page carried no items: the applied end
 * still advances to the round's fixed target and the shell projection
 * refreshes, without any fact or transition work. */
export async function finalizeDeltaMirrorMetaRoundInTx(
  tx: DatabaseTransaction,
  input: {
    group: MirrorGroupAddress;
    through: number;
  },
): Promise<{
  threadId: number;
}> {
  await lockMirrorGroupInTx(tx, input.group);
  const mirror = await requireMirrorMetaInTx(tx, input.group);
  if (mirror.metaRecoveryThroughId !== 0)
    throw new Error('a meta recovery drain opened during this delta round');
  const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
    tx,
    mirror.threadId,
    mirror.threadId,
  );
  await finalizeMirrorMetaRecoveryInTx(tx, {
    threadId: mirror.threadId,
    through: input.through,
    threadLock,
  });
  await advanceMirrorProcessedThroughInTx(
    tx,
    mirror.threadId,
    input.through,
    input.through,
  );
  return { threadId: mirror.threadId };
}

/** Read the compacted member fact before replacing or deleting it. */
async function readCurrentMirrorMemberOperationInTx(
  tx: DatabaseTransaction,
  threadId: number,
  item: MirrorMetaReplicatedItem,
): Promise<
  | {
      operation: string;
      namespaceId: number | null;
      profileRev: number | null;
    }
  | undefined
> {
  if (
    item.operation === 'GROUP_PROFILE' ||
    item.operation === 'GROUP_ANNOUNCEMENT'
  )
    return undefined;
  const previous = await tx.execute<{
    operation: string;
    namespaceId: number | null;
    profileRev: number | null;
  }>(sql`
    SELECT operation,
      CASE WHEN operation = 'MEMBER_UPSERT'
        THEN body -> 'namespaceId' ELSE NULL END AS "namespaceId",
      CASE WHEN operation = 'MEMBER_UPSERT'
        THEN body -> 'profileRev' ELSE NULL END AS "profileRev"
    FROM "GroupMetaMemberFeed"
    WHERE "threadId" = ${threadId} AND body ->> 'account' = ${item.account}
      AND body -> 'namespaceId' = to_jsonb(${item.namespaceId}::integer)
    LIMIT 1
  `);
  return previous.rows[0];
}

/** Meta deltas announce third-party departures and member joins. A local
 * departure is announced by the mirror's relationship-intent transition;
 * replaying its later MEMBER_DEPART here would write a second GROUP_LEFT. */
async function resolveObservedMembershipTransitionInTx(
  tx: DatabaseTransaction,
  threadId: number,
  group: MirrorGroupAddress,
  item: MirrorMetaReplicatedItem,
  previousFact:
    | {
        operation: string;
        namespaceId: number | null;
        profileRev: number | null;
      }
    | undefined,
): Promise<{
  type: 'GROUP_JOINED' | 'GROUP_LEFT';
  memberAddress: ReturnType<typeof groupMemberProfileAddress>;
} | null> {
  if (
    item.operation === 'GROUP_PROFILE' ||
    item.operation === 'GROUP_ANNOUNCEMENT'
  )
    return null;
  const member = { account: item.account, namespaceId: item.namespaceId };
  const joined =
    item.operation === 'MEMBER_UPSERT' &&
    previousFact?.operation !== 'MEMBER_UPSERT';
  const left =
    item.operation === 'MEMBER_DEPART' &&
    previousFact?.operation === 'MEMBER_UPSERT';
  if (!joined && !left) return null;
  // Meta identities remain in the publisher's coordinate space. Recognition
  // records the nonzero coordinate that this publisher assigned to our server;
  // publisher namespace zero identifies the publisher, never a mirror member.
  const publisher = await tx.execute<{ localNamespaceId: number | null }>(sql`
    SELECT "peerAssignedLocalNamespaceId" AS "localNamespaceId"
    FROM "IdentityNamespace"
    WHERE id = ${group.publisherNamespaceId} AND "retiredAt" IS NULL
  `);
  const localNamespaceId = publisher.rows[0]?.localNamespaceId;
  if (localNamespaceId == null)
    throw new Error(
      'mirror publisher has no recognized local namespace binding',
    );
  const localMember = member.namespaceId === localNamespaceId;
  if (left && localMember) return null;
  const profileNamespaceId =
    item.operation === 'MEMBER_UPSERT'
      ? item.namespaceId
      : previousFact?.namespaceId;
  const profileRev =
    item.operation === 'MEMBER_UPSERT'
      ? item.profileRev
      : previousFact?.profileRev;
  if (profileRev === null || profileRev === undefined)
    throw new Error('departing member has no previous profile revision');
  if (profileRev > 0 && profileNamespaceId === null)
    throw new Error('member profile revision has no profile namespace');
  if (localMember) {
    const pair = await tx.execute<{ active: boolean }>(sql`
      SELECT active FROM "RelationshipPair"
      WHERE kind = 'GROUP_MEMBER' AND "threadId" = ${threadId}
        AND "endpointAType" = 'USER' AND "endpointAAccount" = ${member.account}
        AND "endpointANamespaceId" = 0
      LIMIT 1
    `);
    const current = pair.rows[0];
    if (!current?.active) return null;
  }
  const recipients = await readCurrentLocalAuthorizedGroupMemberIdsInTx(tx, {
    groupId: threadId,
    threadId,
  });
  if (!recipients.length) return null;
  const memberAddress = groupMemberProfileAddress({
    account: member.account,
    publisherNamespaceId: group.publisherNamespaceId,
    profileNamespaceId: profileNamespaceId ?? 0,
    profileRev,
  });
  return {
    type: joined ? 'GROUP_JOINED' : 'GROUP_LEFT',
    memberAddress,
  };
}

async function writeBatchedMembershipSystemMessageInTx(
  tx: DatabaseTransaction,
  threadId: number,
  group: MirrorGroupAddress,
  type: typeof SystemMessageType.GROUP_JOINED | typeof SystemMessageType.GROUP_LEFT,
  members: [
    ReturnType<typeof groupMemberProfileAddress>,
    ...ReturnType<typeof groupMemberProfileAddress>[],
  ],
  deps: {
    threadLock: Awaited<
      ReturnType<typeof requireGroupThreadContentLockUnderGroupInTx>
    >;
    messages: Pick<MessageService, 'writeSystemMessageInTx'>;
  },
): Promise<MessageProfileWorkCommittedEvent | undefined> {
  const result = await deps.messages.writeSystemMessageInTx(
    tx,
    threadId,
    {
      type,
      members: members.slice(0, 5) as [
        ReturnType<typeof groupMemberProfileAddress>,
        ...ReturnType<typeof groupMemberProfileAddress>[],
      ],
      totalCount: members.length,
    },
    { threadLock: deps.threadLock },
  );
  const work = collectCommittedProfileWork([
    {
      threadType: 'GROUP',
      threadId,
      seq: result.message.seq,
      publisherNamespaceId: group.publisherNamespaceId,
      creator: {
        account: result.message.creator!.account,
        profileNamespaceId: result.message.creator!.namespaceId,
        profileRev: result.message.profileRev,
      },
      contentType: result.message.contentType,
      content: result.message.content,
      isDeleted: result.message.isDeleted,
      localState: result.message.localState,
      groupAccount: group.account,
    },
  ]);
  if (work.demands.length === 0 && work.evidenceProjections.length === 0)
    return undefined;
  return work;
}
