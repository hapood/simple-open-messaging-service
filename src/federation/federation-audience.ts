import { groupStateSql } from '../group/group-state.js';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import {
  messageThread,
  peerStateFeed,
  systemSetting,
  threadAudience,
} from '../database/schema.js';
import { loadFederationConfig } from './federation.config.js';
import {
  FEDERATION_HISTORY_ACCESS_SETTING_KEY,
  federationHistoryAccessEnabled,
} from './federation-history-access-setting.js';

/** Open directional peer query access. Repeated REQUESTED/ACCEPTED writes are idempotent and never
 * move the audience scan position backwards. A new audience may query retained history in either
 * direction; an explicit later retention boundary is represented by messageAccessAfterSeq. */
export async function openFederatedAudienceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
  groupMetaVisibleAfter = 0n,
): Promise<boolean> {
  const namespaceId = await resolveAudienceNamespaceInTx(
    tx,
    peerDomain,
    threadId,
  );
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
      targetDomain: peerDomain,
      targetNamespaceId: namespaceId,
      localUserId: null,
      threadId,
      messageAccessAfterSeq,
      groupMetaVisibleAfter,
    })
    .onConflictDoNothing({
      target: [threadAudience.targetNamespaceId, threadAudience.threadId],
      where: sql`${threadAudience.targetDomain} <> 'local'`,
    })
    .returning({ id: threadAudience.id });
  return inserted.length > 0;
}

/** Close the current audience and remove its compacted thread-content projection. */
export async function closeFederatedAudienceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
): Promise<boolean> {
  const localDomain = loadFederationConfig().domain;
  const namespaceId = await resolveAudienceNamespaceInTx(
    tx,
    peerDomain,
    threadId,
  );
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
    LEFT JOIN ${groupStateSql} group_state ON group_state.id = thread.id
    LEFT JOIN "RelationshipPair" pair
      ON pair."threadId" = thread.id AND pair.kind = 'P2P'
    LEFT JOIN LATERAL (
      SELECT CASE
               WHEN pair."endpointADomain" = 'local' THEN pair."endpointAAccount"
               WHEN pair."endpointBDomain" = 'local' THEN pair."endpointBAccount"
             END AS account
    ) local_user ON true
    LEFT JOIN LATERAL (
      SELECT CASE
               WHEN pair."endpointADomain" = ${peerDomain}
                 AND pair."endpointANamespaceId" = ${namespaceId}
                 THEN pair."endpointAAccount"
               WHEN pair."endpointBDomain" = ${peerDomain}
                 AND pair."endpointBNamespaceId" = ${namespaceId}
                 THEN pair."endpointBAccount"
             END AS account
    ) peer_user ON true
    WHERE thread.id = ${threadId}
    LIMIT 1
  `);
  const deleted = await tx
    .delete(threadAudience)
    .where(
      and(
        eq(threadAudience.targetDomain, peerDomain),
        eq(threadAudience.targetNamespaceId, namespaceId),
        eq(threadAudience.threadId, threadId),
        isNull(threadAudience.localUserId),
      ),
    )
    .returning({ id: threadAudience.id });
  const key = address.rows[0];
  if (key)
    await tx
      .delete(peerStateFeed)
      .where(
        and(
          eq(peerStateFeed.peerDomain, peerDomain),
          eq(peerStateFeed.namespaceId, namespaceId),
          eq(peerStateFeed.account, key.account),
          eq(peerStateFeed.domain, localDomain),
          eq(peerStateFeed.eventType, 'THREAD_CONTENT_HEAD'),
          eq(peerStateFeed.subjectAccount, key.subjectAccount),
          eq(peerStateFeed.subjectDomain, key.subjectDomain),
        ),
      );
  return deleted.length > 0;
}

async function resolveAudienceNamespaceInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  threadId: number,
): Promise<number> {
  const candidates = await tx.execute<{ namespaceId: number }>(sql`
    SELECT DISTINCT candidate."namespaceId"
    FROM (
      SELECT pair."endpointANamespaceId" AS "namespaceId"
      FROM "RelationshipPair" pair
      WHERE pair."threadId" = ${threadId}
        AND pair."endpointANamespaceId" = pair."endpointBNamespaceId"
        AND (pair."endpointADomain" = ${peerDomain}
          OR pair."endpointBDomain" = ${peerDomain})
      UNION
      SELECT group_profile."namespaceId"
      FROM "MessageThread" thread
      JOIN ${groupStateSql} group_profile ON group_profile.id = thread.id
      WHERE thread.id = ${threadId} AND group_profile.domain = ${peerDomain}
    ) candidate
    WHERE candidate."namespaceId" > 0
    LIMIT 2
  `);
  if (candidates.rows.length !== 1) {
    throw new Error(
      `thread ${threadId} does not resolve one namespace for ${peerDomain}`,
    );
  }
  return candidates.rows[0].namespaceId;
}
