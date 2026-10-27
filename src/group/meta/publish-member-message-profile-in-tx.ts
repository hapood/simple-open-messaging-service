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
  // Message coordinates are publisher-scoped: publisherNamespaceId is this
  // server's local IdentityNamespace id for the accepting publisher, and
  // namespaceId is the subject's home-namespace id in that publisher's space.
  // The roster fact and relationship instead address the member by this
  // server's local identity namespace. A publisher-home subject (namespace 0)
  // is locally identified by the publisher's own namespace; a third-home
  // subject is identified through its pinned root-key binding. A local
  // publisher (0) already carries the local identity namespace directly.
  let memberNamespaceId =
    publisherNamespaceId === 0 ? namespaceId : publisherNamespaceId;
  if (publisherNamespaceId !== 0 && namespaceId !== 0) {
    const binding = await tx.execute<{ namespaceId: number }>(sql`
      SELECT identity.id AS "namespaceId" FROM "ProfileNamespace" binding
      JOIN "IdentityNamespace" identity
        ON identity."rootPublicKey" = binding."rootPublicKey"
      WHERE binding."publisherNamespaceId" = ${publisherNamespaceId}
        AND binding."profileNamespaceId" = ${namespaceId}
        AND binding.expired = false AND binding.status = 'ACTIVE'
        AND identity."retiredAt" IS NULL
    `);
    const identity = binding.rows[0];
    if (!identity) return false;
    memberNamespaceId = identity.namespaceId;
  }
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
      AND (body -> 'namespaceId') = to_jsonb(${memberNamespaceId}::integer) AND operation = 'MEMBER_UPSERT'
      AND EXISTS (
        SELECT 1 FROM "RelationshipPair" pair
        WHERE pair."threadId" = ${groupId} AND pair.kind = 'GROUP_MEMBER'
          AND pair.active
          AND pair."endpointBType" = 'USER'
          AND pair."endpointBAccount" = ${account}
          AND pair."endpointBNamespaceId" = ${memberNamespaceId}
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
  // A message admitted as a STUB (validated federated media whose bytes are
  // still downloading) has already committed its profile evidence, so both
  // READY and STUB rows are selectable; FAILED placeholders never are.
  // Selection never depends on a stored profile snapshot: the exact-revision
  // cache is a separate display concern resolved after the fact changes.
  const evidence = await tx.execute(sql`
    SELECT 1 FROM "Message" m
    WHERE m."threadId" = ${groupId} AND m.seq = ${messageSeq}
      AND m."creatorAccount" = ${account}
      AND m."publisherNamespaceId" = ${publisherNamespaceId}
      AND m."profileNamespaceId" = ${namespaceId}
      AND m."profileRev" = ${profileRev}
      AND m."contentType" <> 'SYSTEM' AND m."localState" IN ('READY', 'STUB')
      AND m.seq > COALESCE((
        SELECT MAX(joined.seq) FROM "Message" joined
        WHERE joined."threadId" = m."threadId"
          AND joined."contentType" = 'SYSTEM'
          AND joined.content ->> 'type' = 'GROUP_JOINED'
          AND joined.content -> 'member' ->> 'account' = ${account}
          AND (
            (COALESCE((joined.content -> 'member' ->> 'publisherNamespaceId')::integer, 0) = 0
              AND (joined.content -> 'member' ->> 'profileNamespaceId')::integer = ${memberNamespaceId})
            OR ((joined.content -> 'member' ->> 'publisherNamespaceId')::integer = ${publisherNamespaceId}
              AND (joined.content -> 'member' ->> 'profileNamespaceId')::integer = ${namespaceId})
          )
      ), 0)
      AND NOT EXISTS (
        SELECT 1 FROM "Message" newer
        WHERE newer."threadId" = m."threadId" AND newer.seq > m.seq
          AND newer."creatorAccount" = m."creatorAccount"
          AND newer."publisherNamespaceId" = m."publisherNamespaceId"
          AND newer."profileNamespaceId" = m."profileNamespaceId"
          AND newer."profileRev" = m."profileRev"
          AND newer."contentType" <> 'SYSTEM'
          AND newer."localState" IN ('READY', 'STUB')
      )
    LIMIT 1
  `);
  if (!evidence.rows.length) return false;
  const feedId = feed.rows[0].metaEndId + 1;
  await tx.execute(sql`
    UPDATE "GroupMetaMemberFeed"
    SET "feedId" = ${feedId}, "profileSourceSeq" = ${messageSeq},
      body = jsonb_set(body, '{profileRev}', to_jsonb(${profileRev}::integer)),
      "createdAt" = CURRENT_TIMESTAMP, "originCreatedAt" = NULL,
      "updatedAt" = CURRENT_TIMESTAMP
    WHERE "threadId" = ${groupId} AND body ->> 'account' = ${account}
      AND (body -> 'namespaceId') = to_jsonb(${memberNamespaceId}::integer) AND operation = 'MEMBER_UPSERT'
  `);
  await tx.execute(sql`
    UPDATE "GroupMeta" SET "metaEndId" = ${feedId},
      "updatedAt" = CURRENT_TIMESTAMP WHERE "threadId" = ${groupId}
  `);
  await enqueueCurrentThreadFanoutsInTx(tx, threadLock);
  return true;
}
