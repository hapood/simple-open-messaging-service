import { eq, sql } from 'drizzle-orm';
import { validateNamespacedAddress } from '../../common/client-identity.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { messageThread } from '../../database/schema.js';
import { MessageService } from '../../message/message.service.js';
import { SystemMessageType } from '../../message/system-message.js';
import { enqueueThreadFanoutInTx } from '../../message/thread-fanout-task.js';
import { readCurrentLocalAuthorizedGroupMemberIdsInTx } from './current-group-roster.js';
import { requireGroupThreadContentLockUnderGroupInTx } from '../../common/locks/thread-content-lock.js';
import type { ProfilePrefetchDemand } from '../../profile-resolution/profile-resolution-demand.js';
import { collectCommittedProfileWork } from '../../message/collect-committed-profile-work.js';
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
  if (mirror.metaRecoveryThroughId !== null)
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
    input.group.publisherNamespaceId,
    input.item,
  );
  await applyMirrorMetaFactInTx(
    tx,
    mirror.threadId,
    input.group,
    input.item,
    'delta',
  );
  const transition = await writeObservedMembershipTransitionInTx(
    tx,
    mirror.threadId,
    input.group,
    input.item,
    previousFact,
    { threadLock, messages: input.messages },
  );
  const transitioned = transition.transitioned;
  if (!transitioned) {
    // A meta-only advance is legitimate member-visible progress: publish the
    // current head so the new coordinate reaches every member's thread feed.
    const [head] = await tx
      .select({ tombstoneEndSeq: messageThread.tombstoneEndSeq })
      .from(messageThread)
      .where(eq(messageThread.id, mirror.threadId))
      .limit(1);
    if (!head) throw new Error('group-meta mirror thread is missing');
    const messageEnd = await tx.execute<{ head: number }>(sql`
      SELECT COALESCE(max(seq), 0)::integer AS head FROM "Message"
      WHERE "threadId" = ${mirror.threadId}`);
    await enqueueThreadFanoutInTx(tx, threadLock, {
      threadId: mirror.threadId,
      messageEndSeq: messageEnd.rows[0]!.head,
      tombstoneEndSeq: head.tombstoneEndSeq,
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
      ...(transition.profileWork
        ? { systemMessageProfileWork: transition.profileWork }
        : {}),
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
    ...(transition.profileWork
      ? { systemMessageProfileWork: transition.profileWork }
      : {}),
  };
}

function selectChangedMirrorMemberProfileDemand(
  group: DeltaMirrorMetaItemInput['group'],
  item: MirrorMetaReplicatedItem,
  previousFact:
    | {
        operation: string;
        profileNamespaceId: number | null;
        profileRev: number | null;
      }
    | undefined,
): ProfilePrefetchDemand | null {
  if (
    item.operation === 'MEMBER_UPSERT' &&
    previousFact?.operation === 'MEMBER_UPSERT' &&
    previousFact.profileNamespaceId === item.profileNamespaceId &&
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
  if (mirror.metaRecoveryThroughId !== null)
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
  namespaceId: number,
  item: MirrorMetaReplicatedItem,
): Promise<
  | {
      operation: string;
      profileNamespaceId: number | null;
      profileRev: number | null;
    }
  | undefined
> {
  if (
    item.operation === 'GROUP_PROFILE' ||
    item.operation === 'GROUP_ANNOUNCEMENT'
  )
    return undefined;
  const member = validateNamespacedAddress({
    account: item.account,
    domain: item.domain,
    namespaceId: item.profileNamespaceId,
  });
  const previous = await tx.execute<{
    operation: string;
    profileNamespaceId: number | null;
    profileRev: number | null;
  }>(sql`
    SELECT operation,
      CASE WHEN operation = 'MEMBER_UPSERT'
        THEN (body ->> 'profileNamespaceId')::integer ELSE NULL END AS "profileNamespaceId",
      CASE WHEN operation = 'MEMBER_UPSERT'
        THEN (body ->> 'profileRev')::integer ELSE NULL END AS "profileRev"
    FROM "GroupMetaMemberFeed"
    WHERE "threadId" = ${threadId} AND "memberAccount" = ${member.account}
      AND "profileNamespaceId" = ${member.namespaceId}
    LIMIT 1
  `);
  return previous.rows[0];
}

/** Meta deltas announce third-party departures and member joins. A local
 * departure is announced by the mirror's relationship-intent transition;
 * replaying its later MEMBER_DEPART here would write a second GROUP_LEFT. */
async function writeObservedMembershipTransitionInTx(
  tx: DatabaseTransaction,
  threadId: number,
  group: MirrorGroupAddress,
  item: MirrorMetaReplicatedItem,
  previousFact:
    | {
        operation: string;
        profileNamespaceId: number | null;
        profileRev: number | null;
      }
    | undefined,
  deps: {
    threadLock: Awaited<
      ReturnType<typeof requireGroupThreadContentLockUnderGroupInTx>
    >;
    messages: Pick<MessageService, 'writeSystemMessageInTx'>;
  },
): Promise<{
  transitioned: boolean;
  profileWork?: MessageProfileWorkCommittedEvent;
}> {
  if (
    item.operation === 'GROUP_PROFILE' ||
    item.operation === 'GROUP_ANNOUNCEMENT'
  )
    return { transitioned: false };
  const member = validateNamespacedAddress({
    account: item.account,
    domain: item.domain,
    namespaceId: item.profileNamespaceId,
  });
  const joined =
    item.operation === 'MEMBER_UPSERT' &&
    previousFact?.operation !== 'MEMBER_UPSERT';
  const left =
    item.operation === 'MEMBER_DEPART' &&
    previousFact?.operation === 'MEMBER_UPSERT';
  if (!joined && !left) return { transitioned: false };
  if (left && member.namespaceId === 0) return { transitioned: false };
  const profileNamespaceId =
    item.operation === 'MEMBER_UPSERT'
      ? item.profileNamespaceId
      : previousFact?.profileNamespaceId;
  const profileRev =
    item.operation === 'MEMBER_UPSERT'
      ? item.profileRev
      : previousFact?.profileRev;
  if (profileRev === null || profileRev === undefined)
    throw new Error('departing member has no previous profile revision');
  if (profileRev > 0 && profileNamespaceId === null)
    throw new Error('member profile revision has no profile namespace');
  if (member.namespaceId === 0) {
    const pair = await tx.execute<{ active: boolean }>(sql`
      SELECT active FROM "RelationshipPair"
      WHERE kind = 'GROUP_MEMBER' AND "threadId" = ${threadId}
        AND "endpointAType" = 'USER' AND "endpointAAccount" = ${member.account}
        AND "endpointANamespaceId" = 0
      LIMIT 1
    `);
    const current = pair.rows[0];
    if (!current?.active) return { transitioned: false };
  }
  const recipients = await readCurrentLocalAuthorizedGroupMemberIdsInTx(tx, {
    groupId: threadId,
    threadId,
  });
  if (!recipients.length) return { transitioned: false };
  const result = await deps.messages.writeSystemMessageInTx(
    tx,
    threadId,
    {
      type: joined
        ? SystemMessageType.GROUP_JOINED
        : SystemMessageType.GROUP_LEFT,
      member: {
        account: member.account,
        domain: member.domain,
        profileNamespaceId: profileNamespaceId ?? 0,
        profileRev,
      },
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
    return { transitioned: true };
  return { transitioned: true, profileWork: work };
}
