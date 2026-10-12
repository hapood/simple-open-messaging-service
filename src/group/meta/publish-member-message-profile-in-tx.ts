import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import type { ThreadContentLock } from '../../common/locks/thread-content-lock.js';
import { enqueueCurrentThreadFanoutsInTx } from '../../message/thread-fanout-task.js';

export interface MemberMessageProfileCandidate {
  threadLock: ThreadContentLock;
  account: string;
  publisherNamespaceId: number;
  namespaceId: number;
  messageSeq: number;
  profileRev: number;
}

/** A post-fetch origin transaction: the caller holds the group business and
 * thread-content locks. Message admission already committed independently. */
export async function publishMemberMessageProfileInTx(
  tx: DatabaseTransaction,
  candidate: MemberMessageProfileCandidate,
): Promise<boolean> {
  const {
    threadLock,
    account,
    publisherNamespaceId,
    namespaceId,
    messageSeq,
    profileRev,
  } = candidate;
  if (
    !Number.isSafeInteger(messageSeq) ||
    messageSeq < 1 ||
    !Number.isSafeInteger(publisherNamespaceId) ||
    publisherNamespaceId < 0 ||
    !Number.isSafeInteger(namespaceId) ||
    namespaceId < 0 ||
    !Number.isSafeInteger(profileRev) ||
    profileRev < 0
  )
    throw new RangeError('invalid committed member-message coordinate');
  const groupId = threadLock.threadId;
  const feed = await tx.execute<{ metaEndId: number }>(sql`
    SELECT meta."metaEndId" FROM "GroupMeta" meta
    JOIN "MessageThread" thread ON thread.id = meta."threadId"
    WHERE meta."threadId" = ${groupId} AND thread.type = 'GROUP'
      AND thread."authorityNamespaceId" = 0
      AND thread."groupAccountId" IS NOT NULL
    FOR NO KEY UPDATE OF meta
  `);
  if (!feed.rows[0]) return false;
  const member = await tx.execute<{
    profileRev: number;
    profileSourceSeq: number | null;
  }>(sql`
    SELECT body -> 'profileRev' AS "profileRev", "profileSourceSeq"
    FROM "GroupMetaMemberFeed"
    WHERE "threadId" = ${groupId} AND body ->> 'account' = ${account}
      AND (body -> 'namespaceId') = to_jsonb(${namespaceId}::integer) AND operation = 'MEMBER_UPSERT'
      AND EXISTS (
        SELECT 1 FROM "RelationshipPair" pair
        WHERE pair."threadId" = ${groupId} AND pair.kind = 'GROUP_MEMBER'
          AND pair.active
          AND pair."endpointBType" = 'USER'
          AND pair."endpointBAccount" = ${account}
          AND pair."endpointBNamespaceId" = ${namespaceId}
      )
    FOR NO KEY UPDATE
  `);
  const current = member.rows[0];
  if (
    !current ||
    (current.profileSourceSeq !== null &&
      current.profileSourceSeq >= messageSeq) ||
    current.profileRev === profileRev
  )
    return false;
  // Existing GROUP_JOINED notifications delimit subsequent membership
  // incarnations without an extra cursor or comparison of Meta IDs to seqs.
  // The greatest committed authored seq in this incarnation wins; an old
  // asynchronous fetch cannot resurrect an earlier revision after rejoin.
  const evidence = await tx.execute(sql`
    SELECT 1 FROM "Message" m
    WHERE m."threadId" = ${groupId} AND m.seq = ${messageSeq}
      AND m."creatorAccount" = ${account}
      AND m."publisherNamespaceId" = ${publisherNamespaceId}
      AND m."profileNamespaceId" = ${namespaceId}
      AND m."profileRev" = ${profileRev}
      AND m."contentType" <> 'SYSTEM' AND m."localState" = 'READY'
      AND m.seq > COALESCE((
        SELECT MAX(joined.seq) FROM "Message" joined
        WHERE joined."threadId" = m."threadId"
          AND joined."contentType" = 'SYSTEM'
          AND joined.content ->> 'type' = 'GROUP_JOINED'
          AND joined.content -> 'member' ->> 'account' = ${account}
          AND (joined.content -> 'member' ->> 'profileNamespaceId')::integer = ${namespaceId}
      ), 0)
      AND NOT EXISTS (
        SELECT 1 FROM "Message" newer
        WHERE newer."threadId" = m."threadId" AND newer.seq > m.seq
          AND newer."creatorAccount" = m."creatorAccount"
          AND newer."publisherNamespaceId" = m."publisherNamespaceId"
          AND newer."profileNamespaceId" = m."profileNamespaceId"
          AND newer."profileRev" = m."profileRev"
          AND newer."contentType" <> 'SYSTEM'
          AND newer."localState" = 'READY'
      )
      AND (${profileRev} = 0 OR EXISTS (
        SELECT 1 FROM "Profile" p
        WHERE p.account = m."creatorAccount"
          AND p."publisherNamespaceId" = ${publisherNamespaceId}
          AND p."profileNamespaceId" = m."profileNamespaceId"
          AND p."profileRev" = ${profileRev}
      ))
    LIMIT 1
  `);
  if (!evidence.rows.length) return false;
  const feedId = feed.rows[0].metaEndId + 1;
  await tx.execute(sql`
    UPDATE "GroupMetaMemberFeed"
    SET "feedId" = ${feedId}, "profileSourceSeq" = ${messageSeq},
      body = jsonb_set(body, '{profileRev}', to_jsonb(${profileRev}::integer)),
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "threadId" = ${groupId} AND body ->> 'account' = ${account}
      AND (body -> 'namespaceId') = to_jsonb(${namespaceId}::integer) AND operation = 'MEMBER_UPSERT'
  `);
  await tx.execute(sql`
    UPDATE "GroupMeta" SET "metaEndId" = ${feedId},
      "updatedAt" = CURRENT_TIMESTAMP WHERE "threadId" = ${groupId}
  `);
  await enqueueCurrentThreadFanoutsInTx(tx, threadLock);
  return true;
}
