import { sql, type SQL } from 'drizzle-orm';
import {
  clientIntentFeedWriteSql,
  peerIntentFeedWriteSql,
} from '../../../common/sql/relationship-intent-recipient-feed-sql.js';
import { toFederationWireDomain } from '../../../federation/federation-wire-domain.js';

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
 * injection). A missing reverse direction publishes nothing. */
export function userIntentClientBodiesSql(
  input: UserIntentFeedInput & {
    /** The statement's UNION ALL read-back of the authored direction (id,
     * status, "profileRev", note, "requestedAt", "expiresAt"). Sibling CTEs
     * cannot see one another's base-table writes, so the authored side must
     * come from the read-back, never from the base table. */
    ownState: string;
    /** Optional read-back of an in-statement reverse-direction write (the
     * acceptance's reverse upgrade). The upgrade's base-table effect is
     * invisible to this statement's snapshot, so the published reverse body
     * overlays the read-back onto the base row and falls back to the base
     * values when the write no-oped. */
    reverseState?: string;
    establishedOverride?: SQL;
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
    ? sql`LEFT JOIN ${sql.raw(input.reverseState)} rv ON rv."authorSide" = s."authorSide"`
    : sql``;
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
        s."peerDomain", s.ordinal, ${reverseState},
        p."threadId" AS "localThreadId", ${established} AS established
      FROM sides s
      JOIN "RelationshipPair" p ON p.id = ${input.pairId}
      JOIN "RelationshipIntent" i ON i."pairId" = ${input.pairId}
        AND i."authorSide" = s."authorSide"
      ${reverseJoin}
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
    ), recipient_directions AS MATERIALIZED (
      SELECT o.id AS "userId", d.*,
        k."compactionKey",
        CASE WHEN o.account = d."actorAccount" THEN 'OUTGOING' ELSE 'INCOMING' END AS direction,
        CASE WHEN o.account = d."actorAccount" THEN d."peerAccount" ELSE d."actorAccount" END
          AS "clientPeerAccount",
        CASE WHEN o.account = d."actorAccount" THEN d."peerDomain" ELSE d."actorDomain" END
          AS "clientPeerDomain"
      FROM directions d
      JOIN (VALUES ('A'::text, ${input.keyA}::text), ('B'::text, ${input.keyB}::text))
        k("authorSide", "compactionKey") ON k."authorSide" = d."authorSide"
      JOIN "Account" o ON o.domain = 'local' AND o."namespaceId" = 0
        AND o.availability = 'AVAILABLE'
        AND ((o.account = d."actorAccount" AND d."actorDomain" = 'local')
          OR (o.account = d."peerAccount" AND d."peerDomain" = 'local'))
    ), client_peers AS MATERIALIZED (
      SELECT rd.*, COALESCE(peer_intent."profileRev", 0) AS "clientPeerProfileRev"
      FROM recipient_directions rd
      LEFT JOIN directions peer_intent
        ON peer_intent."actorAccount" = rd."clientPeerAccount"
        AND peer_intent."actorDomain" = rd."clientPeerDomain"
    ), candidate_bodies AS MATERIALIZED (
      SELECT cp."userId", ${input.namespaceId}::integer AS "namespaceId", cp.ordinal,
        cp."compactionKey",
        cp."actorAccount" AS account, cp."actorDomain" AS domain,
        cp."peerAccount" AS "subjectAccount", cp."peerDomain" AS "subjectDomain",
        jsonb_build_object(
          'status', cp.status, 'note', cp.note,
          'requestedAt', cp."requestedAt", 'expiresAt', cp."expiresAt",
          'direction', cp.direction,
          'localThreadId', cp."localThreadId", 'established', cp.established,
          'peer', jsonb_build_object('account', cp."clientPeerAccount", 'name',
            COALESCE(pr."displayName", cp."clientPeerAccount"), 'avatar', COALESCE(pr.avatar, ''),
            'bio', COALESCE(pr.bio, ''), 'domain', cp."clientPeerDomain",
            'profileRev', cp."clientPeerProfileRev")
        ) AS body
      FROM client_peers cp
      LEFT JOIN "Profile" pr ON cp."clientPeerProfileRev" > 0
        AND pr."profileRev" = cp."clientPeerProfileRev"
        AND pr.account = cp."clientPeerAccount" AND pr.domain = cp."clientPeerDomain"
        AND pr."namespaceId" = (CASE WHEN cp."clientPeerDomain" = 'local' THEN 0 ELSE ${input.namespaceId} END)
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
  const wireLocalDomain = toFederationWireDomain(input.localDomain);
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
