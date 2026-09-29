import { sql, type SQL } from 'drizzle-orm';
import {
  clientIntentFeedWriteSql,
  peerIntentFeedWriteSql,
} from '../../../common/sql/relationship-intent-recipient-feed-sql.js';

/** Inputs shared by every composed user intent statement that publishes the
 * pair's current directions. Identities arrive normalized and lowercased; the
 * command actor and the addressed target name the two endpoints directly, so
 * every direction below is addressed by its author coordinates. */
export interface UserIntentFeedInput {
  pairId: bigint;
  threadId: number;
  namespaceId: number;
  localDomain: string;
  /** Compaction key of the direction authored by the command actor. */
  actorKey: string;
  /** Compaction key of the direction authored by the addressed target. */
  targetKey: string;
  actorAccount: string;
  actorDomain: string;
  actorNamespaceId: number;
  targetAccount: string;
  targetDomain: string;
  targetNamespaceId: number;
}

/** Both directed intents → per-local-recipient RELATIONSHIP_INTENT feed bodies.
 * Mirrors writeP2PClientRelationshipInTx: each current direction is published
 * to every available local endpoint, outgoing from the reader's viewpoint, with
 * the peer's profile snapshot at the intent's captured revision and the pair's
 * sticky established flag (the service's hasEstablishedThreadRelationship
 * injection). A missing reverse direction publishes nothing. */
export function userIntentClientBodiesSql(
  input: UserIntentFeedInput & {
    /** The statement's UNION ALL read-back of the authored direction (status,
     * "profileRev", note, "requestedAt", "expiresAt"). Sibling CTEs cannot see
     * one another's base-table writes, so the authored direction must come
     * from the read-back, never from the base table. */
    ownState: string;
    /** Optional read-back of an in-statement reverse-direction write (the
     * acceptance's reverse upgrade). The upgrade's base-table effect is
     * invisible to this statement's snapshot, so the published reverse body
     * overlays the read-back onto the base row and falls back to the base
     * values when the write no-oped. */
    reverseState?: string;
    establishedOverride?: SQL;
    requestRevocation?: boolean;
  },
): SQL {
  const established = input.establishedOverride
    ? sql`COALESCE((${input.establishedOverride}), p.established)`
    : sql`p.established`;
  const reverseState = input.reverseState
    ? sql`COALESCE(rv.status, i.status) AS status, COALESCE(rv.note, i.note) AS note,
        COALESCE(rv."profileRev", i."profileRev") AS "profileRev",
        floor(extract(epoch FROM COALESCE(rv."requestedAt", i."requestedAt")) * 1000)::bigint AS "requestedAt",
        CASE WHEN COALESCE(rv."expiresAt", i."expiresAt") IS NULL THEN NULL
          ELSE floor(extract(epoch FROM COALESCE(rv."expiresAt", i."expiresAt")) * 1000)::bigint END AS "expiresAt"`
    : sql`i.status AS status, i.note AS note, i."profileRev" AS "profileRev",
        floor(extract(epoch FROM i."requestedAt") * 1000)::bigint AS "requestedAt",
        CASE WHEN i."expiresAt" IS NULL THEN NULL
          ELSE floor(extract(epoch FROM i."expiresAt") * 1000)::bigint END AS "expiresAt"`;
  const reverseJoin = input.reverseState
    ? sql`LEFT JOIN ${sql.raw(input.reverseState)} rv
        ON rv."authorAccount" = s."authorAccount" AND rv."authorNamespaceId" = s."authorNamespaceId"`
    : sql``;
  // Read the live request from the statement snapshot, before the revocation write.
  // Request authorship identifies withdrawal versus rejection; later relationship
  // closure without a live request has no request-card effect.
  const requestOutcome = input.requestRevocation
    ? sql` || COALESCE((
        SELECT jsonb_build_object(
          'requestStatus', CASE WHEN pending."authorAccount" = ${input.actorAccount}
            THEN 'WITHDRAWN' ELSE 'REJECTED' END,
          'requestDirection', CASE WHEN pending."authorAccount" = cp."authorAccount"
            THEN cp.direction ELSE CASE WHEN cp.direction = 'OUTGOING'
              THEN 'INCOMING' ELSE 'OUTGOING' END END)
        FROM "RelationshipIntent" pending
        WHERE (
            (pending."authorAccount" = ${input.actorAccount} AND pending."authorNamespaceId" = ${input.actorNamespaceId}
              AND pending."receiverAccount" = ${input.targetAccount} AND pending."receiverNamespaceId" = ${input.targetNamespaceId})
            OR (pending."authorAccount" = ${input.targetAccount} AND pending."authorNamespaceId" = ${input.targetNamespaceId}
              AND pending."receiverAccount" = ${input.actorAccount} AND pending."receiverNamespaceId" = ${input.actorNamespaceId})
          )
          AND pending.status = 'REQUESTED'
          AND pending."expiresAt" > CURRENT_TIMESTAMP
          AND cp.status = 'REVOKED' AND cp."authorAccount" = ${input.actorAccount}
        ORDER BY (pending."authorAccount" = ${input.actorAccount}) DESC
        LIMIT 1
      ), '{}'::jsonb)`
    : sql.empty();
  return sql`
    sides AS MATERIALIZED (
      SELECT ${input.actorAccount}::text AS "authorAccount",
        ${input.actorDomain}::text AS "authorDomain",
        ${input.actorNamespaceId}::int AS "authorNamespaceId",
        ${input.targetAccount}::text AS "peerAccount",
        ${input.targetDomain}::text AS "peerDomain",
        ${input.targetNamespaceId}::int AS "peerNamespaceId",
        1 AS ordinal
      UNION ALL
      SELECT ${input.targetAccount}, ${input.targetDomain}, ${input.targetNamespaceId},
        ${input.actorAccount}, ${input.actorDomain}, ${input.actorNamespaceId}, 2
    ), directions AS MATERIALIZED (
      SELECT s."authorAccount", s."authorDomain", s."peerAccount", s."peerDomain",
        s.ordinal, ${reverseState},
        p."threadId" AS "localThreadId", ${established} AS established
      FROM sides s
      JOIN "RelationshipPair" p ON p.id = ${input.pairId}
      JOIN "RelationshipIntent" i
        ON i."authorAccount" = s."authorAccount" AND i."authorNamespaceId" = s."authorNamespaceId"
        AND i."receiverAccount" = s."peerAccount" AND i."receiverNamespaceId" = s."peerNamespaceId"
      ${reverseJoin}
      WHERE s."authorAccount" <> ${input.actorAccount}
      UNION ALL
      SELECT s."authorAccount", s."authorDomain", s."peerAccount", s."peerDomain",
        s.ordinal, v.status, v.note, v."profileRev",
        floor(extract(epoch FROM v."requestedAt") * 1000)::bigint AS "requestedAt",
        CASE WHEN v."expiresAt" IS NULL THEN NULL
          ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END AS "expiresAt",
        p."threadId" AS "localThreadId", ${established} AS established
      FROM sides s
      JOIN "RelationshipPair" p ON p.id = ${input.pairId}
      JOIN ${sql.raw(input.ownState)} v ON s."authorAccount" = ${input.actorAccount}
    ), recipient_directions AS MATERIALIZED (
      SELECT o.id AS "userId", d.*,
        k."compactionKey",
        CASE WHEN o.account = d."authorAccount" THEN 'OUTGOING' ELSE 'INCOMING' END AS direction,
        CASE WHEN o.account = d."authorAccount" THEN d."peerAccount" ELSE d."authorAccount" END
          AS "clientPeerAccount",
        CASE WHEN o.account = d."authorAccount" THEN d."peerDomain" ELSE d."authorDomain" END
          AS "clientPeerDomain"
      FROM directions d
      JOIN (VALUES (${input.actorAccount}::text, ${input.actorKey}::text),
                   (${input.targetAccount}::text, ${input.targetKey}::text))
        k("authorAccount", "compactionKey") ON k."authorAccount" = d."authorAccount"
      JOIN "Account" o ON o.domain = 'local' AND o."namespaceId" = 0
        AND o.availability = 'AVAILABLE'
        AND ((o.account = d."authorAccount" AND d."authorDomain" = 'local')
          OR (o.account = d."peerAccount" AND d."peerDomain" = 'local'))
    ), client_peers AS MATERIALIZED (
      SELECT rd.*, COALESCE(peer_intent."profileRev", 0) AS "clientPeerProfileRev"
      FROM recipient_directions rd
      LEFT JOIN directions peer_intent
        ON peer_intent."authorAccount" = rd."clientPeerAccount"
        AND peer_intent."authorDomain" = rd."clientPeerDomain"
    ), candidate_bodies AS MATERIALIZED (
      SELECT cp."userId", ${input.namespaceId}::integer AS "namespaceId", cp.ordinal,
        cp."compactionKey",
        cp."authorAccount" AS account, cp."authorDomain" AS domain,
        cp."peerAccount" AS "subjectAccount", cp."peerDomain" AS "subjectDomain",
        jsonb_build_object(
          'status', cp.status, 'note', cp.note,
          'requestedAt', cp."requestedAt", 'expiresAt', cp."expiresAt",
          'direction', cp.direction,
          'localThreadId', cp."localThreadId", 'established', cp.established,
          'peer', jsonb_build_object('account', cp."clientPeerAccount", 'name',
            cp."clientPeerAccount", 'avatar', '',
            'bio', '', 'domain', cp."clientPeerDomain",
            'profileRev', cp."clientPeerProfileRev")
        )${requestOutcome} AS body
      FROM client_peers cp
    ), ${clientIntentFeedWriteSql(
      input.requestRevocation
        ? {
            // A new request can be rejected while our own direction remains
            // REVOKED from an earlier decision. Re-announce the terminal card
            // effect after every live request, even when the body is identical.
            force: sql`b.body ? 'requestStatus' AND b.body->>'status' = 'REVOKED'`,
          }
        : undefined,
    )}
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
  const wireLocalDomain = 'local';
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
        AND old.account = ${input.actorAccount} AND old.domain = ${wireLocalDomain}
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
