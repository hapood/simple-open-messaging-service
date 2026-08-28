import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  messageThread,
  peerStateFeed,
  threadAudience,
} from '../database/schema.js';
import { loadFederationConfig } from './federation.config.js';

/** Open directional peer query access. Repeated REQUESTED/ACCEPTED writes are idempotent and never
 * move the audience scan position backwards. A newly authorized audience starts at the current
 * thread boundary, so first authorization and reauthorization cannot expose an unauthorized gap. */
export async function openFederatedAudienceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
): Promise<void> {
  const [thread] = await tx
    .select({ curSeq: messageThread.curSeq })
    .from(messageThread)
    .where(eq(messageThread.id, threadId))
    .limit(1);
  if (!thread) throw new Error(`thread ${threadId} does not exist`);
  await tx
    .insert(threadAudience)
    .values({
      targetDomain: peerDomain,
      localUserId: null,
      threadId,
      messageAccessAfterSeq: thread.curSeq,
    })
    .onConflictDoNothing({
      target: [threadAudience.targetDomain, threadAudience.threadId],
      where: sql`${threadAudience.targetDomain} <> 'local'`,
    });
}

/** Close the current audience and remove its compacted thread-content projection. */
export async function closeFederatedAudienceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
): Promise<void> {
  const localDomain = loadFederationConfig().domain;
  const address = await tx.execute<{
    account: string;
    subjectAccount: string;
    subjectDomain: string;
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
             WHEN thread.type = 'GROUP' THEN 'local'
             ELSE ${peerDomain}
           END AS "subjectDomain"
    FROM "MessageThread" thread
    LEFT JOIN "Group" group_state ON group_state.id = thread."groupId"
    LEFT JOIN LATERAL (
      SELECT member.account
      FROM "ThreadMember" link
      JOIN "User" member ON member.id = link."userId"
      WHERE link."threadId" = thread.id AND member.domain = 'local'
      LIMIT 1
    ) local_user ON true
    LEFT JOIN LATERAL (
      SELECT member.account
      FROM "ThreadMember" link
      JOIN "User" member ON member.id = link."userId"
      WHERE link."threadId" = thread.id AND member.domain = ${peerDomain}
      LIMIT 1
    ) peer_user ON true
    WHERE thread.id = ${threadId}
    LIMIT 1
  `);
  await tx
    .delete(threadAudience)
    .where(
      and(
        eq(threadAudience.targetDomain, peerDomain),
        eq(threadAudience.threadId, threadId),
        isNull(threadAudience.localUserId),
      ),
    );
  const key = address.rows[0];
  if (key)
    await tx
      .delete(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.peerDomain, peerDomain),
          eq(peerStateFeed.account, key.account),
          eq(peerStateFeed.domain, localDomain),
          eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          eq(peerStateFeed.subjectAccount, key.subjectAccount),
          eq(peerStateFeed.subjectDomain, key.subjectDomain),
        ),
      );
}
