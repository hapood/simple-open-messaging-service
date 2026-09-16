import { eq, sql } from 'drizzle-orm';
import { toClientIdentity } from '../../common/client-identity.js';
import type { DatabaseTransaction } from '../../database/database.service.js';
import { messageThread } from '../../database/schema.js';
import { loadFederationConfig } from '../../federation/federation.config.js';
import { MessageService } from '../../message/message.service.js';
import { SystemMessageType } from '../../message/system-message.js';
import { enqueueThreadFanoutInTx } from '../../message/thread-fanout-task.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../../client-state-feed/client-state-feed.service.js';
import { readCurrentLocalAuthorizedGroupMemberIdsInTx } from './current-group-roster.js';
import { requireGroupThreadContentLockUnderGroupInTx } from '../../common/locks/thread-content-lock.js';
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
  clientStateFeed: Pick<
    ClientStateFeedService,
    'publishGroupProfileToLocalAccountsInTx'
  >;
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
  clientFeedUpdates: PendingClientStateFeedUpdate[];
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
  const previousOperation = await readCurrentMirrorMemberOperationInTx(
    tx,
    mirror.threadId,
    input.group.namespaceId,
    input.item,
  );
  await applyMirrorMetaFactInTx(
    tx,
    mirror.threadId,
    input.group,
    input.item,
    'delta',
  );
  const transitioned = await writeObservedMembershipTransitionInTx(
    tx,
    mirror.threadId,
    input.group.namespaceId,
    input.item,
    previousOperation,
    { threadLock, messages: input.messages },
  );
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
    const clientFeedUpdates = await finalizeMirrorMetaRecoveryInTx(tx, {
      threadId: mirror.threadId,
      through: input.through,
      threadLock,
      clientStateFeed: input.clientStateFeed,
    });
    await advanceMirrorProcessedThroughInTx(
      tx,
      mirror.threadId,
      input.item.feedId,
      input.through,
    );
    return { threadId: mirror.threadId, clientFeedUpdates };
  }
  await advanceMirrorProcessedThroughInTx(
    tx,
    mirror.threadId,
    input.item.feedId,
    input.through,
  );
  return { threadId: mirror.threadId, clientFeedUpdates: [] };
}

/** Closes a delta round whose final page carried no items: the applied end
 * still advances to the round's fixed target and the shell projection
 * refreshes, without any fact or transition work. */
export async function finalizeDeltaMirrorMetaRoundInTx(
  tx: DatabaseTransaction,
  input: {
    group: MirrorGroupAddress;
    through: number;
    clientStateFeed: Pick<
      ClientStateFeedService,
      'publishGroupProfileToLocalAccountsInTx'
    >;
  },
): Promise<{
  threadId: number;
  clientFeedUpdates: PendingClientStateFeedUpdate[];
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
  const clientFeedUpdates = await finalizeMirrorMetaRecoveryInTx(tx, {
    threadId: mirror.threadId,
    through: input.through,
    threadLock,
    clientStateFeed: input.clientStateFeed,
  });
  await advanceMirrorProcessedThroughInTx(
    tx,
    mirror.threadId,
    input.through,
    input.through,
  );
  return { threadId: mirror.threadId, clientFeedUpdates };
}

/** Read the compacted member fact before replacing or deleting it. */
async function readCurrentMirrorMemberOperationInTx(
  tx: DatabaseTransaction,
  threadId: number,
  namespaceId: number,
  item: MirrorMetaReplicatedItem,
): Promise<string | undefined> {
  if (item.operation === 'GROUP_PROFILE') return undefined;
  const member = toClientIdentity(
    { account: item.account, domain: item.domain, namespaceId },
    loadFederationConfig().domain,
  );
  const previous = await tx.execute<{ operation: string }>(sql`
    SELECT operation FROM "GroupMetaMemberFeed"
    WHERE "threadId" = ${threadId} AND "memberAccount" = ${member.account}
      AND "memberDomain" = ${member.domain}
    LIMIT 1
  `);
  return previous.rows[0]?.operation;
}

/** Meta deltas announce third-party departures and member joins. A local
 * departure is announced by the mirror's relationship-intent transition;
 * replaying its later DEPART here would write a second GROUP_LEFT. */
async function writeObservedMembershipTransitionInTx(
  tx: DatabaseTransaction,
  threadId: number,
  namespaceId: number,
  item: MirrorMetaReplicatedItem,
  previousOperation: string | undefined,
  deps: {
    threadLock: Awaited<
      ReturnType<typeof requireGroupThreadContentLockUnderGroupInTx>
    >;
    messages: Pick<MessageService, 'writeSystemMessageInTx'>;
  },
): Promise<boolean> {
  if (item.operation === 'GROUP_PROFILE') return false;
  const member = toClientIdentity(
    { account: item.account, domain: item.domain, namespaceId },
    loadFederationConfig().domain,
  );
  const joined = item.operation === 'UPSERT' && previousOperation !== 'UPSERT';
  const left = item.operation === 'DEPART' && previousOperation === 'UPSERT';
  if (!joined && !left) return false;
  if (left && member.domain === 'local') return false;
  if (member.domain === 'local') {
    const pair = await tx.execute<{ active: boolean }>(sql`
      SELECT active FROM "RelationshipPair"
      WHERE kind = 'GROUP_MEMBER' AND "threadId" = ${threadId}
        AND "endpointBType" = 'USER' AND "endpointBAccount" = ${member.account}
        AND "endpointBDomain" = 'local'
      LIMIT 1
    `);
    const current = pair.rows[0];
    if (!current?.active) return false;
  }
  const recipients = await readCurrentLocalAuthorizedGroupMemberIdsInTx(tx, {
    groupId: threadId,
    threadId,
  });
  if (!recipients.length) return false;
  await deps.messages.writeSystemMessageInTx(
    tx,
    threadId,
    {
      type: joined
        ? SystemMessageType.GROUP_JOINED
        : SystemMessageType.GROUP_LEFT,
      member,
    },
    { threadLock: deps.threadLock },
  );
  return true;
}
