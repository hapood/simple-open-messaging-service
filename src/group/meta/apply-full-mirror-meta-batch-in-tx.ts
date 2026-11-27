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

/** Commit a complete full Group Meta drain in one transaction, without
 * system messages. Clearing and replacing the roster shares its cursor commit.
 * Lock order: group Account State scope, Thread Content lock, GroupMeta and
 * roster facts. */
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
  if (!input.reachedBoundary || input.scannedThrough !== input.through)
    throw new Error('full group-meta requires a complete fixed-through drain');
  const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
    tx,
    mirror.threadId,
    mirror.threadId,
  );
  const previousMembers = new Map<
    string,
    { account: string; namespaceId: number; profileRev: number }
  >();
  if (mirror.metaProcessedThroughId > 0) {
    const existingRows = await tx.execute<{
      account: string;
      namespaceId: number;
      profileRev: number;
    }>(sql`
      SELECT
        body->>'account' AS account,
        (body->>'namespaceId')::integer AS "namespaceId",
        COALESCE((body->>'profileRev')::integer, 0) AS "profileRev"
      FROM "GroupMetaMemberFeed"
      WHERE "threadId" = ${mirror.threadId}
        AND operation = 'MEMBER_UPSERT'
    `);
    for (const row of existingRows.rows) {
      previousMembers.set(`${row.namespaceId}:${row.account}`, row);
    }
  }
  // Retain facts at the same coordinate so recovery cannot reset their first
  // local persistence time. Remove facts absent from the completed full scan.
  await tx.execute(sql`
    DELETE FROM "GroupMetaMemberFeed"
    WHERE "threadId" = ${mirror.threadId}
      AND "feedId" <> ALL(${sql.param(input.items.map((item) => item.feedId))}::integer[])
  `);
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
  if (input.messages && mirror.metaProcessedThroughId > 0) {
    const nextMembers = new Map<
      string,
      { account: string; namespaceId: number; profileRev: number }
    >();
    for (const item of input.items) {
      if (item.operation === 'MEMBER_UPSERT') {
        nextMembers.set(`${item.namespaceId}:${item.account}`, {
          account: item.account,
          namespaceId: item.namespaceId,
          profileRev: item.profileRev,
        });
      }
    }
    const joined = [...nextMembers.entries()]
      .filter(([key]) => !previousMembers.has(key))
      .map(([, m]) =>
        groupMemberProfileAddress({
          account: m.account,
          publisherNamespaceId: input.group.publisherNamespaceId,
          profileNamespaceId: m.namespaceId,
          profileRev: m.profileRev,
        }),
      );
    const localNamespaceId = input.group.publisherNamespaceId;
    const left = [...previousMembers.entries()]
      .filter(
        ([key, m]) => !nextMembers.has(key) && m.namespaceId !== localNamespaceId,
      )
      .map(([, m]) =>
        groupMemberProfileAddress({
          account: m.account,
          publisherNamespaceId: input.group.publisherNamespaceId,
          profileNamespaceId: m.namespaceId,
          profileRev: m.profileRev,
        }),
      );
    if (joined.length > 0 || left.length > 0) {
      const recipients = await readCurrentLocalAuthorizedGroupMemberIdsInTx(
        tx,
        { groupId: mirror.threadId, threadId: mirror.threadId },
      );
      if (recipients.length > 0) {
        for (const [type, members] of [
          [SystemMessageType.GROUP_JOINED, joined] as const,
          [SystemMessageType.GROUP_LEFT, left] as const,
        ]) {
          if (members.length === 0) continue;
          const result = await input.messages.writeSystemMessageInTx(
            tx,
            mirror.threadId,
            {
              type,
              members: members.slice(0, 5) as [
                (typeof members)[0],
                ...(typeof members)[0][],
              ],
              totalCount: members.length,
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
          if (
            work.demands.length > 0 ||
            work.evidenceProjections.length > 0
          ) {
            systemMessageProfileWorks.push(work);
          }
        }
      }
    }
  }
  await finalizeMirrorMetaRecoveryInTx(tx, {
    threadId: mirror.threadId,
    through: input.through,
    threadLock,
  });
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
