import { eq, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import {
  groupMeta,
  groupMetaMemberFeed,
  messageThread,
} from '../../database/schema.js';
import { enqueueThreadFanoutInTx } from '../../message/thread-fanout-task.js';
import { requireGroupThreadContentLockUnderGroupInTx } from '../../common/locks/thread-content-lock.js';
import type { ProfilePrefetchDemand } from '../../profile-resolution/profile-resolution-demand.js';
import { selectMirrorMetaProfileDemand } from './select-mirror-meta-profile-demand.js';
import { upsertCurrentGroupMetaFactsInTx } from './current-group-meta-fact.js';
import { reconcileClientMemberCountInTx } from './reconcile-client-member-count-in-tx.js';
import { publishClientGroupFactInTx } from './publish-client-group-fact-in-tx.js';
import { MessageService } from '../../message/message.service.js';
import { SystemMessageType } from '../../message/system-message.js';
import { collectCommittedProfileWork } from '../../message/collect-committed-profile-work.js';
import type { MessageProfileWorkCommittedEvent } from '../../message/message-profile-work.event.js';
import { groupMemberProfileAddress } from './group-member-profile-address.js';
import { readCurrentLocalAuthorizedGroupMemberIdsInTx } from './current-group-roster.js';
import type {
  MirrorGroupAddress,
  MirrorMetaReplicatedItem,
} from './mirror-meta-shared.js';
import {
  advanceMirrorProcessedThroughInTx,
  finalizeMirrorMetaRecoveryInTx,
  lockMirrorGroupInTx,
  requireMirrorMetaInTx,
} from './mirror-meta-shared.js';

export interface FullMirrorMetaBatchInput {
  group: MirrorGroupAddress;
  items: readonly MirrorMetaReplicatedItem[];
  /** The open recovery drain's fixed through; the round aborts if it moved. */
  through: number;
  /** The fetched page's scanned-through; the scan cursor advances to it. */
  scannedThrough: number;
  /** True for the drain's last page: the applied end advances to `through`,
   * the drain closes, and the shell projection refreshes here. */
  reachedBoundary: boolean;
  messages?: Pick<MessageService, 'writeSystemMessageInTx'>;
}

/** Commit one full Group Meta page. The window open already cleared the
 * previous roster. This page upserts its facts and announces members that
 * were not already present. The last page closes the window. Lock order:
 * group Account State scope, Thread Content lock, GroupMeta and roster facts. */
export async function applyFullMirrorMetaBatchInTx(
  tx: DatabaseTransaction,
  input: FullMirrorMetaBatchInput,
): Promise<{
  threadId: number;
  profileDemands: ProfilePrefetchDemand[];
  systemMessageProfileWorks: MessageProfileWorkCommittedEvent[];
}> {
  await lockMirrorGroupInTx(tx, input.group);
  const mirror = await requireMirrorMetaInTx(tx, input.group);
  if (mirror.metaRecoveryThroughId === 0)
    throw new Error('the meta recovery drain closed during this round');
  if (mirror.metaRecoveryThroughId !== input.through)
    throw new Error('the meta recovery drain changed during this round');
  if (input.reachedBoundary) {
    if (input.scannedThrough !== input.through)
      throw new Error('full group-meta boundary did not reach its fixed through');
  } else if (input.scannedThrough >= input.through) {
    throw new Error('full group-meta page passed its fixed through');
  } else if (input.scannedThrough <= mirror.metaProcessedThroughId) {
    throw new Error('full group-meta page did not advance the scan cursor');
  }
  const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
    tx,
    mirror.threadId,
    mirror.threadId,
  );
  const joinedMembers: {
    account: string;
    namespaceId: number;
    profileRev: number;
  }[] = [];
  for (const item of input.items) {
    if (item.operation !== 'MEMBER_UPSERT') continue;
    const previous = await tx.execute<{ operation: string }>(sql`
      SELECT operation FROM "GroupMetaMemberFeed"
      WHERE "threadId" = ${mirror.threadId}
        AND body ->> 'account' = ${item.account}
        AND body -> 'namespaceId' = to_jsonb(${item.namespaceId}::integer)
        AND operation <> 'GROUP_ANNOUNCEMENT'
      LIMIT 1
    `);
    if (previous.rows[0]?.operation === 'MEMBER_UPSERT') continue;
    joinedMembers.push({
      account: item.account,
      namespaceId: item.namespaceId,
      profileRev: item.profileRev,
    });
  }
  const profileDemands = input.items
    .map((item) => selectMirrorMetaProfileDemand(input.group, item))
    .filter((demand): demand is ProfilePrefetchDemand => demand !== null);
  type MirrorFactInsert = (typeof groupMetaMemberFeed)['$inferInsert'];
  const facts = input.items.flatMap<MirrorFactInsert>((item) => {
    if (item.operation === 'MEMBER_DEPART')
      throw new Error(
        'a full group-meta snapshot cannot contain MEMBER_DEPART',
      );
    if (item.operation === 'GROUP_ANNOUNCEMENT')
      return [
        {
          threadId: mirror.threadId,
          feedId: item.feedId,
          originCreatedAt: new Date(item.originCreatedAt),
          operation: 'GROUP_ANNOUNCEMENT',
          body: { text: item.text },
        },
      ];
    if (item.operation === 'GROUP_PROFILE')
      return [
        {
          threadId: mirror.threadId,
          feedId: item.feedId,
          originCreatedAt: new Date(item.originCreatedAt),
          operation: 'GROUP_PROFILE' as const,
          body: {
            account: item.account,
            namespaceId: item.namespaceId,
            profileRev: item.profileRev,
          },
        },
      ];
    return [
      {
        threadId: mirror.threadId,
        feedId: item.feedId,
        originCreatedAt: new Date(item.originCreatedAt),
        operation: item.operation,
        body: {
          account: item.account,
          namespaceId: item.namespaceId,
          role: item.role,
          profileRev: item.profileRev,
        },
      },
    ];
  });
  await upsertCurrentGroupMetaFactsInTx(tx, facts);
  await reconcileClientMemberCountInTx(tx, threadLock);
  for (const item of input.items) {
    if (item.operation === 'GROUP_ANNOUNCEMENT') {
      await publishClientGroupFactInTx(tx, threadLock, {
        operation: 'GROUP_ANNOUNCEMENT',
        sourceFeedId: item.feedId,
        originCreatedAt: new Date(item.originCreatedAt),
        body: { text: item.text },
      });
    }
  }
  const profile = input.items.find(
    (item) => item.operation === 'GROUP_PROFILE',
  );
  if (profile?.operation === 'GROUP_PROFILE')
    await tx
      .update(groupMeta)
      .set({ profileRev: profile.profileRev, updatedAt: new Date() })
      .where(eq(groupMeta.threadId, mirror.threadId));
  const messageEnd = await tx.execute<{ head: number }>(sql`
    SELECT COALESCE(max(seq), 0)::integer AS head FROM "Message"
    WHERE "threadId" = ${mirror.threadId}`);
  if (profile?.operation === 'GROUP_PROFILE') {
    await enqueueThreadFanoutInTx(tx, threadLock, {
      threadId: mirror.threadId,
      messageEndSeq: messageEnd.rows[0]!.head,
    });
  }
  const systemMessageProfileWorks: MessageProfileWorkCommittedEvent[] = [];
  if (input.messages && joinedMembers.length > 0) {
    const joined = joinedMembers.map((member) =>
      groupMemberProfileAddress({
        account: member.account,
        publisherNamespaceId: input.group.publisherNamespaceId,
        profileNamespaceId: member.namespaceId,
        profileRev: member.profileRev,
      }),
    );
    const recipients = await readCurrentLocalAuthorizedGroupMemberIdsInTx(
      tx,
      { groupId: mirror.threadId, threadId: mirror.threadId },
    );
    if (recipients.length > 0) {
      const result = await input.messages.writeSystemMessageInTx(
        tx,
        mirror.threadId,
        {
          type: SystemMessageType.GROUP_JOINED,
          members: joined.slice(0, 5) as [
            (typeof joined)[0],
            ...(typeof joined)[0][],
          ],
          totalCount: joined.length,
        },
        { threadLock },
      );
      const work = collectCommittedProfileWork([
        {
          threadType: 'GROUP',
          threadId: mirror.threadId,
          seq: result.message.seq,
          publisherNamespaceId: input.group.publisherNamespaceId,
          creator: {
            account: result.message.creator!.account,
            profileNamespaceId: result.message.creator!.namespaceId,
            profileRev: result.message.profileRev,
          },
          contentType: result.message.contentType,
          content: result.message.content,
          localState: result.message.localState,
          isDeleted: false,
          groupAccount: input.group.account,
        },
      ]);
      if (work.demands.length > 0 || work.evidenceProjections.length > 0) {
        systemMessageProfileWorks.push(work);
      }
    }
  }
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
    input.scannedThrough,
    input.through,
  );
  return {
    threadId: mirror.threadId,
    profileDemands,
    systemMessageProfileWorks,
  };
}
