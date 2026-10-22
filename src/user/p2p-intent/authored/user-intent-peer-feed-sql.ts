import { sql, type SQL } from 'drizzle-orm';
import { peerIntentFeedWriteSql } from '../../../common/sql/relationship-intent-recipient-feed-sql.js';

/** Normalized identities for composed protocol writes. No client compaction keys. */
export interface UserIntentFeedInput {
  pairId: bigint;
  threadId: number;
  namespaceId: number;
  actorAccount: string;
  actorNamespaceId: number;
  targetAccount: string;
  targetNamespaceId: number;
}

/** Publish the local actor's post-write direction to its peer. Non-REVOKED
 * bodies include thread heads; acceptance confirmations may be re-announced. */
export function userIntentPeerWriteSql(
  input: UserIntentFeedInput & {
    ownState: string;
    revoked: boolean;
    always: boolean;
    resultName: string;
  },
): SQL {
  const heads = input.revoked
    ? sql`'{}'::jsonb`
    : sql`jsonb_build_object(
        'messageEndSeq', COALESCE((SELECT MAX(m.seq) FROM "Message" m
          WHERE m."threadId" = ${input.threadId} AND m."contentType" <> 'SYSTEM'), 0),
        'tombstoneEndSeq', COALESCE((SELECT MAX(d."deletionSeq") FROM "DeletedMessage" d
          JOIN "Message" m ON m."threadId" = d."threadId" AND m.seq = d."messageSeq"
          WHERE d."threadId" = ${input.threadId} AND d."publisherNamespaceId" = 0), 0))`;
  return sql`
    intent_source AS MATERIALIZED (
      SELECT v.status, v.note, v."profileNamespaceId", v."profileRev", v."requestedAt", v."expiresAt"
      FROM ${sql.raw(input.ownState)} v
    ), peer_write AS MATERIALIZED (
      SELECT jsonb_build_object('status', v.status,
          'namespaceId', v."profileNamespaceId",
          'profileRev', v."profileRev", 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', CASE WHEN v."expiresAt" IS NULL THEN NULL
            ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END) || ${heads} AS body
      FROM intent_source v
    ), peer_changes AS MATERIALIZED (
      SELECT ${input.targetAccount}::text AS "subjectAccount", ${input.targetNamespaceId}::integer AS "subjectNamespaceId",
        p.body, row_number() OVER () AS position, false AS invalid
      FROM peer_write p
      LEFT JOIN "PeerStateFeed" old ON old."namespaceId" = ${input.targetNamespaceId}
        AND old.account = ${input.actorAccount}
        AND old."eventType" = 'RELATIONSHIP_INTENT'
        AND old."subjectAccount" = ${input.targetAccount}
        AND old."subjectNamespaceId" = ${input.targetNamespaceId}
      WHERE old.body IS DISTINCT FROM p.body ${input.always ? sql`OR true` : sql``}
    ), ${peerIntentFeedWriteSql({
      namespaceId: input.targetNamespaceId,
      selfAccount: input.actorAccount,
      resultName: input.resultName,
    })}
  `;
}
