import { groupStateSql } from '../group/shared/group-state.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  messageThread,
  peerStateFeed,
  systemSetting,
  threadAudience,
} from '../database/schema.js';
import {
  FEDERATION_HISTORY_ACCESS_SETTING_KEY,
  federationHistoryAccessEnabled,
} from './federation-history-access-setting.js';

/** Open directional peer query access. Repeated REQUESTED/ACCEPTED writes are idempotent and never
 * move the audience scan position backwards. A new audience may query retained history in either
 * direction; an explicit later retention boundary is represented by messageAccessAfterSeq. */
export async function openFederatedAudienceInTx(
  tx: DatabaseTransaction,
  namespaceId: number,
  threadId: number,
  groupMetaVisibleAfter = 0,
): Promise<boolean> {
  const [thread] = await tx
    .select({ curSeq: messageThread.curSeq })
    .from(messageThread)
    .where(eq(messageThread.id, threadId))
    .limit(1);
  if (!thread) throw new Error(`thread ${threadId} does not exist`);
  const setting = await tx.query.systemSetting.findFirst({
    where: eq(systemSetting.key, FEDERATION_HISTORY_ACCESS_SETTING_KEY),
    columns: { value: true },
  });
  const messageAccessAfterSeq = federationHistoryAccessEnabled(setting?.value)
    ? 0
    : thread.curSeq;
  const inserted = await tx
    .insert(threadAudience)
    .values({
      targetNamespaceId: namespaceId,
      localUserId: null,
      threadId,
      messageAccessAfterSeq,
      groupMetaVisibleAfter,
    })
    .onConflictDoNothing({
      target: [threadAudience.targetNamespaceId, threadAudience.threadId],
      where: sql`${threadAudience.localUserId} IS NULL`,
    })
    .returning({ id: threadAudience.id });
  return inserted.length > 0;
}

/** Close the current audience and remove its compacted thread-content projection. */
export async function closeFederatedAudienceInTx(
  tx: DatabaseTransaction,
  namespaceId: number,
  threadId: number,
): Promise<boolean> {
  const address = await tx.execute<{
    account: string;
    subjectAccount: string;
    subjectNamespaceId: number;
  }>(sql`
    SELECT CASE
             WHEN thread.type = 'GROUP' THEN group_state.account
             ELSE local_user.account
           END AS account,
           CASE
             WHEN thread.type = 'GROUP' THEN ''
             ELSE peer_user.account
           END AS "subjectAccount",
           CASE
             WHEN thread.type = 'GROUP' THEN 0
             ELSE ${namespaceId}
           END AS "subjectNamespaceId"
    FROM "MessageThread" thread
    LEFT JOIN ${groupStateSql} group_state ON group_state.id = thread.id
    LEFT JOIN "RelationshipPair" pair
      ON pair."threadId" = thread.id AND pair.kind = 'P2P'
    LEFT JOIN LATERAL (
      SELECT pair."endpointAAccount" AS account
    ) local_user ON true
    LEFT JOIN LATERAL (
      SELECT pair."endpointBAccount" AS account
    ) peer_user ON true
    WHERE thread.id = ${threadId}
    LIMIT 1
  `);
  const deleted = await tx
    .delete(threadAudience)
    .where(
      and(
        eq(threadAudience.targetNamespaceId, namespaceId),
        eq(threadAudience.threadId, threadId),
        isNull(threadAudience.localUserId),
      ),
    )
    .returning({ id: threadAudience.id });
  const key = address.rows[0];
  if (key) {
    await tx
      .delete(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.namespaceId, namespaceId),
          eq(peerStateFeed.account, key.account),
          eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          eq(peerStateFeed.subjectAccount, key.subjectAccount),
          eq(peerStateFeed.subjectNamespaceId, key.subjectNamespaceId),
        ),
      );
  }
  return deleted.length > 0;
}
