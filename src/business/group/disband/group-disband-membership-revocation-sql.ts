import { sql, type SQL } from 'drizzle-orm';
import { groupStateSql } from '../shared/group-state.js';
import { authoredIntentWriteSql } from '../../shared/sql/authored-relationship-intent-sql.js';
import { requestProjectionFlipSql } from '../membership-intent/shared/group-membership-projection-sql.js';
import {
  clientIntentFeedWriteSql,
  peerIntentFeedWriteSql,
} from '../../shared/sql/relationship-intent-recipient-feed-sql.js';
import { toFederationWireDomain } from '../../../federation/federation-wire-domain.js';

/** Disband sweep command: depart one member of an already-dissolved local
 * group. The member is addressed directly (the sweep enumerates pairs, not
 * request projections), and the caller is the system — no manager, no
 * authorization beyond the dissolved-group invariant. */
export interface GroupDisbandMembershipRevocationInput {
  threadId: number;
  pairId: bigint;
  groupAccount: string;
  groupName: string;
  groupAvatar: string;
  groupDescription: string;
  groupProfileRev: number;
  localDomain: string;
  memberAccount: string;
  memberDomain: string;
  memberNamespaceId: number;
  /** Local Account.id of the member, or null for a peer-hosted member. */
  localMemberId: number | null;
  /** Existing non-REVOKED projection directions for this member, from authorization. */
  projectionDirections: readonly ('APPLICATION' | 'INVITATION')[];
}

/** Use before locking only to name the business scopes and fail fast on a
 * missing group or pair. It authorizes nothing; the dissolved-group gate and
 * every mutable state is re-read after the locks. The pair is optional because
 * group existence and dissolution are evaluated before member state. */
export function groupDisbandMembershipRevocationLocatorSql(input: {
  threadId: number;
  member: { account: string; domain: string; namespaceId: number };
}): SQL {
  return sql`
    SELECT g.account AS "groupAccount", g.domain AS "groupDomain",
      g."dissolvedAt" AS "dissolvedAt",
      pair.id::text AS "pairId",
      (SELECT a.id FROM "Account" a WHERE a.account = ${input.member.account}
        AND a.domain = 'local' AND a."namespaceId" = 0 LIMIT 1) AS "localMemberId"
    FROM ${groupStateSql} g
    LEFT JOIN "RelationshipPair" pair ON pair.kind = 'GROUP_MEMBER'
      AND pair."threadId" = g.id AND pair."endpointBType" = 'USER'
      AND pair."endpointBAccount" = ${input.member.account}
      AND pair."endpointBDomain" = ${input.member.domain}
      AND (${input.member.namespaceId} = 0
        OR pair."endpointBNamespaceId" = ${input.member.namespaceId})
    WHERE g.id = ${input.threadId}
    LIMIT 1
  `;
}

function groupToMemberKey(groupAccount: string, memberAccount: string): string {
  // Matches ClientStateFeedService.compactionKey for the group→member write.
  return JSON.stringify([
    'RELATIONSHIP_INTENT',
    0,
    groupAccount,
    'local',
    memberAccount,
    'local',
  ]);
}

function memberToGroupKey(memberAccount: string, groupAccount: string): string {
  // Matches ClientStateFeedService.compactionKey for the member's own
  // OUTGOING entry — the side B intent's recipient write.
  return JSON.stringify([
    'RELATIONSHIP_INTENT',
    0,
    memberAccount,
    'local',
    groupAccount,
    'local',
  ]);
}

/** One composed statement for the disband sweep's per-member departure. The
 * dissolution boundary is the parent's GROUP_DISSOLVED message; the sweep is
 * deliberately silent — it writes no message, no watermark, and no thread
 * fan-out (the dissolved group keeps its last roster). The parent sweep
 * captures each active member's boundary while admitting that member's child.
 * It authors no
 * reverse task (the group authors both intent sides itself). The intent
 * revocation, the projection flip, the audience close, and the recipient
 * writes run for every still-pending or active pair the full sweep hands over;
 * a fully revoked pair is filtered upstream. Sibling CTEs cannot observe one
 * another's writes, so every read-back derives from the statement's own
 * RETURNING chains. */
export function groupDisbandMembershipRevocationSql(
  input: GroupDisbandMembershipRevocationInput,
): SQL {
  const localMember = input.memberDomain === 'local';
  return sql`
    WITH ${
      localMember
        ? sql`authored_b AS (
      ${authoredIntentWriteSql({
        pair: { id: input.pairId, threadId: input.threadId },
        authorSide: 'B',
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
      })}
    ), `
        : sql``
    }authored AS (
      ${authoredIntentWriteSql({
        pair: { id: input.pairId, threadId: input.threadId },
        authorSide: 'A',
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
      })}
    ), revocation AS MATERIALIZED (
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT id, status, "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent" WHERE "pairId" = ${input.pairId} AND "authorSide" = 'A'
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND "threadId" = ${input.threadId}
        AND active IS DISTINCT FROM false
      RETURNING id
    ), ${requestProjectionFlipSql({
      threadId: input.threadId,
      memberAccount: input.memberAccount,
      memberDomain: input.memberDomain,
      memberNamespaceId: input.memberNamespaceId,
      status: 'REVOKED',
      directions: input.projectionDirections,
    })}, audience_close AS (
      DELETE FROM "ThreadAudience" ta
      WHERE ta."threadId" = ${input.threadId} AND (
        (ta."targetDomain" = 'local' AND ta."localUserId" = ${input.localMemberId}
          AND ta."targetNamespaceId" = 0)
        OR (${localMember ? sql`false` : sql`true`}
          AND ta."targetDomain" = ${input.memberDomain}
          AND ta."targetNamespaceId" = ${input.memberNamespaceId}
          AND NOT EXISTS (SELECT 1 FROM "RelationshipPair" p
            WHERE p.kind = 'GROUP_MEMBER' AND p."threadId" = ${input.threadId}
              AND p.active AND p."endpointBDomain" = ${input.memberDomain}
              AND p."endpointBNamespaceId" = ${input.memberNamespaceId}
              AND p.id <> ${input.pairId})))
      RETURNING ta.id
    ), ${localMember ? localRecipients(input) : peerRecipient(input)}
    SELECT v.id::text AS "requestId", v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM audience_close) AS "audienceChanged",
      (SELECT "userId" FROM recipient_result) AS "recipientUserId",
      (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"
    FROM revocation v
    CROSS JOIN (SELECT count(*) FROM request_projection) projection_barrier
  `;
}

/** The two local recipient entries written for a local member: the group→member
 * compacted RELATIONSHIP_INTENT row (status flip with the group snapshot) and
 * the member's own OUTGOING entry under the member-as-account key, whose
 * requestedAt the REVOKED write clears. */
function localRecipients(input: GroupDisbandMembershipRevocationInput): SQL {
  return sql`
    recipient_bodies AS MATERIALIZED (
      SELECT ${groupToMemberKey(input.groupAccount, input.memberAccount)}::text AS "compactionKey",
        jsonb_build_object('status', v.status, 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', CASE WHEN v."expiresAt" IS NULL THEN NULL
            ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END,
          'threadId', ${input.threadId}::integer,
          'established', (SELECT p.established FROM "RelationshipPair" p WHERE p.id = ${input.pairId}),
          'group', jsonb_build_object('account', ${input.groupAccount}::text, 'domain', 'local',
            'isLocal', true, 'name', ${input.groupName}::text, 'avatar', ${input.groupAvatar}::text,
            'description', ${input.groupDescription}::text, 'profileRev', ${input.groupProfileRev}::integer)
        ) AS body
      FROM revocation v
    ), candidate_bodies AS MATERIALIZED (
      SELECT ${input.localMemberId}::integer AS "userId", 0 AS "namespaceId", 1 AS ordinal,
        b."compactionKey", ${input.groupAccount}::text AS account, 'local'::text AS domain,
        ${input.memberAccount}::text AS "subjectAccount", 'local'::text AS "subjectDomain", b.body
      FROM recipient_bodies b
      UNION ALL
      SELECT ${input.localMemberId}::integer, 0, 2,
        ${memberToGroupKey(input.memberAccount, input.groupAccount)}::text,
        ${input.memberAccount}::text, 'local'::text,
        ${input.groupAccount}::text, 'local'::text,
        jsonb_build_object('status', v.status, 'note', '',
          'requestedAt', NULL::bigint,
          'expiresAt', NULL::bigint,
          'direction', 'OUTGOING',
          'threadId', ${input.threadId}::integer,
          'group', jsonb_build_object('account', ${input.groupAccount}::text, 'domain', 'local',
            'isLocal', true, 'name', ${input.groupName}::text, 'avatar', ${input.groupAvatar}::text,
            'description', ${input.groupDescription}::text, 'profileRev', ${input.groupProfileRev}::integer))
      FROM revocation v
    ), ${clientIntentFeedWriteSql()}
  `;
}

/** Peer recipient for a remote member: one RELATIONSHIP_INTENT REVOKED event,
 * suppressed when the peer already holds the identical body (no feed id is
 * consumed). */
function peerRecipient(input: GroupDisbandMembershipRevocationInput): SQL {
  const wireLocalDomain = toFederationWireDomain(input.localDomain);
  return sql`
    peer_write AS MATERIALIZED (
      SELECT jsonb_build_object('status', v.status, 'profileRev', v."profileRev", 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', CASE WHEN v."expiresAt" IS NULL THEN NULL
            ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END) AS body
      FROM revocation v
    ), peer_changes AS MATERIALIZED (
      SELECT ${input.memberAccount}::text AS "subjectAccount", ${input.memberDomain}::text AS "subjectDomain",
        p.body, row_number() OVER () AS position, false AS invalid
      FROM peer_write p
      LEFT JOIN "PeerStateFeed" old ON old."namespaceId" = ${input.memberNamespaceId}
        AND old.account = ${input.groupAccount} AND old.domain = ${wireLocalDomain}
        AND old."eventType" = 'RELATIONSHIP_INTENT'
        AND old."subjectAccount" = ${input.memberAccount} AND old."subjectDomain" = ${input.memberDomain}
      WHERE old.body IS DISTINCT FROM p.body
    ), ${peerIntentFeedWriteSql({
      namespaceId: input.memberNamespaceId,
      peerDomain: input.memberDomain,
      selfAccount: input.groupAccount,
      selfDomain: input.localDomain,
    })}
  `;
}
