import { sql, type SQL } from 'drizzle-orm';
import {
  clientIntentFeedWriteSql,
  peerIntentFeedWriteSql,
} from '../../shared/sql/relationship-intent-recipient-feed-sql.js';

/** Inputs shared by every composed user intent statement that publishes the
 * pair's current directions. Identities arrive normalized and lowercased. */
export interface UserIntentFeedInput {
  pairId: bigint;
  threadId: number;
  namespaceId: number;
  localDomain: string;
  /** ClientStateFeed compaction keys per pair side, built in TS exactly like
   * ClientStateFeedService.compactionKey: [eventType, namespaceId, account,
   * domain, subjectAccount, subjectDomain]. */
  keyA: string;
  keyB: string;
  actorSide: 'A' | 'B';
  reverseSide: 'A' | 'B';
  actorAccount: string;
  targetAccount: string;
  targetDomain: string;
  targetNamespaceId: number;
}

/** Both directed intents → per-local-recipient RELATIONSHIP_INTENT feed bodies.
 * Mirrors writeP2PClientRelationshipInTx: each current direction is published
 * to every available local endpoint, outgoing from the reader's viewpoint, with
 * the peer's profile snapshot at the intent's captured revision and the pair's
 * sticky established flag (the service's hasEstablishedThreadRelationship
 * injection). A missing reverse direction publishes nothing, exactly like the
 * legacy direction loop. */
export function userIntentClientBodiesSql(
  input: UserIntentFeedInput & {
    /** The statement's UNION ALL read-back of the authored direction (id,
     * status, "profileRev", note, "requestedAt", "expiresAt"). Sibling CTEs
     * cannot see one another's base-table writes, so the authored side must
     * come from the read-back, never from the base table. */
    ownState: string;
    establishedOverride?: SQL;
  },
): SQL {
  const established = input.establishedOverride
    ? sql`COALESCE((${input.establishedOverride}), p.established)`
    : sql`p.established`;
  return sql`
    sides AS MATERIALIZED (
      SELECT 'A'::text AS "authorSide", p."endpointAAccount" AS "actorAccount",
        p."endpointADomain" AS "actorDomain", p."endpointBAccount" AS "peerAccount",
        p."endpointBDomain" AS "peerDomain", 1 AS ordinal
      FROM "RelationshipPair" p WHERE p.id = ${input.pairId}
      UNION ALL
      SELECT 'B'::text, p."endpointBAccount", p."endpointBDomain", p."endpointAAccount",
        p."endpointADomain", 2
      FROM "RelationshipPair" p WHERE p.id = ${input.pairId}
    ), directions AS MATERIALIZED (
      SELECT s."authorSide", s."actorAccount", s."actorDomain", s."peerAccount",
        s."peerDomain", s.ordinal, i.status, i.note, i."profileRev",
        floor(extract(epoch FROM i."requestedAt") * 1000)::bigint AS "requestedAt",
        CASE WHEN i."expiresAt" IS NULL THEN NULL
          ELSE floor(extract(epoch FROM i."expiresAt") * 1000)::bigint END AS "expiresAt",
        p."threadId" AS "localThreadId", ${established} AS established
      FROM sides s
      JOIN "RelationshipPair" p ON p.id = ${input.pairId}
      JOIN "RelationshipIntent" i ON i."pairId" = ${input.pairId}
        AND i."authorSide" = s."authorSide"
      WHERE s."authorSide" <> ${input.actorSide}
      UNION ALL
      SELECT s."authorSide", s."actorAccount", s."actorDomain", s."peerAccount",
        s."peerDomain", s.ordinal, v.status, v.note, v."profileRev",
        floor(extract(epoch FROM v."requestedAt") * 1000)::bigint AS "requestedAt",
        CASE WHEN v."expiresAt" IS NULL THEN NULL
          ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END AS "expiresAt",
        p."threadId" AS "localThreadId", ${established} AS established
      FROM sides s
      JOIN "RelationshipPair" p ON p.id = ${input.pairId}
      JOIN ${sql.raw(input.ownState)} v ON s."authorSide" = ${input.actorSide}
    ), peer_snapshot AS MATERIALIZED (
      SELECT d."authorSide", pr."displayName", pr.avatar, pr.bio
      FROM directions d
      LEFT JOIN "Profile" pr ON d."profileRev" > 0
        AND pr."profileRev" = d."profileRev"
        AND pr.account = d."peerAccount" AND pr.domain = d."peerDomain"
        AND pr."namespaceId" = (CASE WHEN d."peerDomain" = 'local' THEN 0 ELSE ${input.namespaceId} END)
    ), candidate_bodies AS MATERIALIZED (
      SELECT o.id AS "userId", ${input.namespaceId}::integer AS "namespaceId", d.ordinal,
        k."compactionKey",
        d."actorAccount" AS account, d."actorDomain" AS domain,
        d."peerAccount" AS "subjectAccount", d."peerDomain" AS "subjectDomain",
        jsonb_build_object(
          'status', d.status, 'note', d.note,
          'requestedAt', d."requestedAt", 'expiresAt', d."expiresAt",
          'direction', CASE WHEN o.account = d."actorAccount" THEN 'OUTGOING' ELSE 'INCOMING' END,
          'localThreadId', d."localThreadId", 'established', d.established,
          'peer', jsonb_build_object('account', d."peerAccount", 'name',
            COALESCE(pp."displayName", d."peerAccount"), 'avatar', COALESCE(pp.avatar, ''),
            'bio', COALESCE(pp.bio, ''), 'domain', d."peerDomain", 'profileRev', d."profileRev")
        ) AS body
      FROM directions d
      JOIN (VALUES ('A'::text, ${input.keyA}::text), ('B'::text, ${input.keyB}::text))
        k("authorSide", "compactionKey") ON k."authorSide" = d."authorSide"
      LEFT JOIN peer_snapshot pp ON pp."authorSide" = d."authorSide"
      JOIN "Account" o ON o.domain = 'local' AND o."namespaceId" = 0
        AND o.availability = 'AVAILABLE'
        AND ((o.account = d."actorAccount" AND d."actorDomain" = 'local')
          OR (o.account = d."peerAccount" AND d."peerDomain" = 'local'))
    ), ${clientIntentFeedWriteSql()}
  `;
}

/** One RELATIONSHIP_INTENT event for a peer-hosted endpoint, published from the
 * local actor's post-write direction. Non-REVOKED bodies carry the thread head
 * snapshot (PeerStateFeedService's readRelationshipHeadInTx enrichment);
 * REVOKED keeps the bare shape. `always` reproduces
 * writeAcceptanceConfirmationsInTx: an acceptance is re-announced even over an
 * identical stored body. */
export function userIntentPeerWriteSql(
  input: UserIntentFeedInput & {
    ownState: string;
    revoked: boolean;
    always: boolean;
    resultName: string;
  },
): SQL {
  // `jsonb || '{}'` is the identity: REVOKED bodies keep the bare shape.
  const heads = input.revoked
    ? sql`'{}'::jsonb`
    : sql`jsonb_build_object(
        'messageEndSeq', COALESCE((SELECT MAX(m.seq) FROM "Message" m
          WHERE m."threadId" = ${input.threadId} AND m."contentType" <> 'SYSTEM'), 0),
        'tombstoneEndSeq', COALESCE((SELECT MAX(d."deletionSeq") FROM "DeletedMessage" d
          JOIN "Message" m ON m."threadId" = d."threadId" AND m.seq = d."messageSeq"
          WHERE d."threadId" = ${input.threadId} AND d."sourceNamespaceId" = 0), 0))`;
  return sql`
    intent_source AS MATERIALIZED (
      SELECT v.status, v.note, v."profileRev", v."requestedAt", v."expiresAt"
      FROM ${sql.raw(input.ownState)} v
    ), peer_write AS MATERIALIZED (
      SELECT jsonb_build_object('status', v.status, 'profileRev', v."profileRev", 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', CASE WHEN v."expiresAt" IS NULL THEN NULL
            ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END) || ${heads} AS body
      FROM intent_source v
    ), peer_changes AS MATERIALIZED (
      SELECT ${input.targetAccount}::text AS "subjectAccount", ${input.targetDomain}::text AS "subjectDomain",
        p.body, row_number() OVER () AS position, false AS invalid
      FROM peer_write p
      LEFT JOIN "PeerStateFeed" old ON old."namespaceId" = ${input.targetNamespaceId}
        AND old.account = ${input.actorAccount} AND old.domain = ${input.localDomain}
        AND old."eventType" = 'RELATIONSHIP_INTENT'
        AND old."subjectAccount" = ${input.targetAccount}
        AND old."subjectDomain" = ${input.targetDomain}
      WHERE old.body IS DISTINCT FROM p.body ${input.always ? sql`OR true` : sql``}
    ), ${peerIntentFeedWriteSql({
      namespaceId: input.targetNamespaceId,
      peerDomain: input.targetDomain,
      selfAccount: input.actorAccount,
      selfDomain: input.localDomain,
      resultName: input.resultName,
    })}
  `;
}
