import { sql, type SQL } from 'drizzle-orm';
import type { AccountSubjectAddress } from '../../user/account-address.js';
import { groupStateSql } from '../shared/group-state.js';
import { authoredIntentWriteSql } from '../../common/sql/authored-relationship-intent-sql.js';
import {
  peerIntentFeedWriteSql,
} from '../../common/sql/relationship-intent-recipient-feed-sql.js';

/** Disband sweep command: depart one member of an already-dissolved local
 * group. The member is addressed directly (the sweep enumerates pairs, not
 * request projections), and the caller is the system — no manager, no
 * authorization beyond the dissolved-group invariant. */
export interface GroupDisbandMembershipRevocationInput {
  threadId: number;
  pairId: bigint;
  groupAccount: string;
  groupName: string;
  groupProfileRev: number;
  memberAccount: string;
  profileNamespaceId: number;
  /** Local Account.id of the member, or null for a peer-hosted member. */
  localMemberId: number | null;
  /** Existing non-REVOKED projection directions for this member, from authorization. */
}

/** Use before locking only to name the business scopes and fail fast on a
 * missing group or pair. It authorizes nothing; the dissolved-group gate and
 * every mutable state is re-read after the locks. The pair is optional because
 * group existence and dissolution are evaluated before member state. */
export function groupDisbandMembershipRevocationLocatorSql(input: {
  threadId: number;
  member: AccountSubjectAddress;
}): SQL {
  return sql`
    SELECT g.account AS "groupAccount",
      g."namespaceId" AS "groupNamespaceId",
      member_ns.id AS "memberNamespaceId",
      g."dissolvedAt" AS "dissolvedAt",
      pair.id::text AS "pairId",
      (SELECT a.id FROM "Account" a WHERE a.account = ${input.member.account}
        AND a."namespaceId" = 0 LIMIT 1) AS "localMemberId"
    FROM ${groupStateSql} g
    LEFT JOIN "IdentityNamespace" member_ns
      ON member_ns.id = ${input.member.namespaceId}
    LEFT JOIN "RelationshipPair" pair ON pair.kind = 'GROUP_MEMBER'
      AND pair."threadId" = g.id AND pair."endpointBType" = 'USER'
      AND pair."endpointBAccount" = ${input.member.account}
      AND pair."endpointBNamespaceId" = ${input.member.namespaceId}
    WHERE g.id = ${input.threadId}
    LIMIT 1
  `;
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
  const localMember = input.profileNamespaceId === 0;
  return sql`
    WITH ${
      localMember
        ? sql`authored_b AS (
      ${authoredIntentWriteSql({
        author: {
          account: input.memberAccount,
          namespaceId: input.profileNamespaceId,
        },
        receiver: { account: input.groupAccount, namespaceId: 0 },
        threadId: input.threadId,
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
      })}
    ), `
        : sql``
    }authored AS (
      ${authoredIntentWriteSql({
        author: { account: input.groupAccount, namespaceId: 0 },
        profileRev: input.groupProfileRev,
        receiver: {
          account: input.memberAccount,
          namespaceId: input.profileNamespaceId,
        },
        threadId: input.threadId,
        status: 'REVOKED',
        note: '',
        requestedAt: null,
        expiresAt: null,
      })}
    ), revocation AS MATERIALIZED (
      SELECT "authorAccount", "authorNamespaceId", status, "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT "authorAccount", "authorNamespaceId", status, "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.groupAccount} AND "authorNamespaceId" = 0
        AND "receiverAccount" = ${input.memberAccount}
        AND "receiverNamespaceId" = ${input.profileNamespaceId}
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), pair_change AS (
      UPDATE "RelationshipPair" SET active = false, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${input.pairId} AND "threadId" = ${input.threadId}
        AND active IS DISTINCT FROM false
      RETURNING id
    ), audience_close AS (
      DELETE FROM "ThreadAudience" ta
      WHERE ta."threadId" = ${input.threadId} AND (
        (ta."localUserId" = ${input.localMemberId}
          AND ta."targetNamespaceId" = 0)
        OR (${localMember ? sql`false` : sql`true`}
          AND ta."targetNamespaceId" = ${input.profileNamespaceId}
          AND NOT EXISTS (SELECT 1 FROM "RelationshipPair" p
            WHERE p.kind = 'GROUP_MEMBER' AND p."threadId" = ${input.threadId}
              AND p.active AND p."endpointBNamespaceId" = ${input.profileNamespaceId}
              AND p.id <> ${input.pairId})))
      RETURNING ta.id
    ) ${localMember ? sql.empty() : sql`, ${peerRecipient(input)}`}
    SELECT v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      EXISTS (SELECT 1 FROM pair_change) AS "pairChanged",
      EXISTS (SELECT 1 FROM audience_close) AS "audienceChanged"
      ${localMember ? sql.empty() : sql`,
        (SELECT "userId" FROM recipient_result) AS "recipientUserId",
        (SELECT "feedId" FROM recipient_result) AS "recipientFeedId"`}
    FROM revocation v
  `;
}

/** Peer recipient for a remote member: one RELATIONSHIP_INTENT REVOKED event,
 * suppressed when the peer already holds the identical body (no feed id is
 * consumed). */
function peerRecipient(input: GroupDisbandMembershipRevocationInput): SQL {
  return sql`
    peer_write AS MATERIALIZED (
      SELECT jsonb_build_object('status', v.status, 'namespaceId', 0,
          'profileRev', v."profileRev", 'note', v.note,
          'requestedAt', floor(extract(epoch FROM v."requestedAt") * 1000)::bigint,
          'expiresAt', CASE WHEN v."expiresAt" IS NULL THEN NULL
            ELSE floor(extract(epoch FROM v."expiresAt") * 1000)::bigint END) AS body
      FROM revocation v
    ), peer_changes AS MATERIALIZED (
      SELECT ${input.memberAccount}::text AS "subjectAccount", ${input.profileNamespaceId}::integer AS "subjectNamespaceId",
        p.body, row_number() OVER () AS position, false AS invalid
      FROM peer_write p
      LEFT JOIN "PeerStateFeed" old ON old."namespaceId" = ${input.profileNamespaceId}
        AND old.account = ${input.groupAccount}
        AND old."eventType" = 'RELATIONSHIP_INTENT'
        AND old."subjectAccount" = ${input.memberAccount} AND old."subjectNamespaceId" = ${input.profileNamespaceId}
      WHERE old.body IS DISTINCT FROM p.body
    ), ${peerIntentFeedWriteSql({
      namespaceId: input.profileNamespaceId,
      selfAccount: input.groupAccount,
    })}
  `;
}
