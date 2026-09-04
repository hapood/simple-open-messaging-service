import { HttpStatus } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseTransaction } from '../database/database.service.js';

export type FederationThreadAddress =
  | { account: string; peerAccount: string }
  | { account: string };

export type FederationThreadQuery =
  | { type: 'GROUP'; account: string }
  | { type: 'P2P'; account: string; peerAccount: string };

export interface AuthorizedFederationThread {
  threadId: number;
  messageAccessAfterSeq: number;
  address: FederationThreadAddress;
  groupQueryDirection: 'ORIGIN_DISTRIBUTION' | 'MIRROR_TO_ORIGIN' | null;
}

/**
 * Resolve and lock the authorization fact for one federation thread query.
 *
 * A query is authorized by an effective direction authored by this publisher. P2P uses the local
 * user-to-peer direction. GROUP origin-to-member-home publication uses a group-authored intent;
 * member-home-to-origin publication uses a member-authored intent belonging to a local account that
 * has retained AccountThreadState. ThreadAudience supplies an optional history floor only on the
 * authoritative server; it is not the authorization fact. An intent-authorized query holds a shared
 * intent lock for its bounded page transaction, so a concurrent revocation either wins first or waits
 * for that page to finish.
 */
export async function resolveAuthorizedFederationThreadInTx(
  tx: DatabaseTransaction,
  peerDomain: string,
  namespaceId: number,
  selector: FederationThreadQuery,
): Promise<AuthorizedFederationThread> {
  if (selector.type === 'GROUP') {
    const originRows = await tx.execute<{
      threadId: number;
      messageAccessAfterSeq: number;
      groupQueryDirection: 'ORIGIN_DISTRIBUTION';
    }>(sql`
      SELECT thread.id AS "threadId",
        COALESCE(audience."messageAccessAfterSeq", 0) AS "messageAccessAfterSeq",
        'ORIGIN_DISTRIBUTION' AS "groupQueryDirection"
      FROM "Group" group_state
      JOIN "MessageThread" thread ON thread."groupId" = group_state.id
      JOIN "RelationshipPair" pair
        ON pair."threadId" = thread.id
       AND pair.kind = 'GROUP_MEMBER'
      JOIN "RelationshipIntent" intent
        ON intent."pairId" = pair.id
       AND (
         (
           pair."endpointAType" = 'GROUP'
           AND pair."endpointAAccount" = group_state.account
           AND pair."endpointADomain" = 'local'
           AND pair."endpointANamespaceId" = ${namespaceId}
           AND pair."endpointBType" = 'USER'
           AND pair."endpointBDomain" = ${peerDomain}
           AND pair."endpointBNamespaceId" = ${namespaceId}
           AND intent."authorSide" = 'A'
         ) OR (
           pair."endpointBType" = 'GROUP'
           AND pair."endpointBAccount" = group_state.account
           AND pair."endpointBDomain" = 'local'
           AND pair."endpointBNamespaceId" = ${namespaceId}
           AND pair."endpointAType" = 'USER'
           AND pair."endpointADomain" = ${peerDomain}
           AND pair."endpointANamespaceId" = ${namespaceId}
           AND intent."authorSide" = 'B'
         )
       )
      LEFT JOIN "ThreadAudience" audience
        ON audience."threadId" = thread.id
       AND audience."targetDomain" = ${peerDomain}
       AND audience."targetNamespaceId" = ${namespaceId}
       AND audience."localUserId" IS NULL
      WHERE thread.type = 'GROUP'
        AND group_state.account = ${selector.account}
        AND group_state.domain = 'local'
        AND group_state."namespaceId" = 0
        AND (
          intent.status = 'ACCEPTED'
          OR (
            intent.status = 'REQUESTED'
            AND intent."expiresAt" > CURRENT_TIMESTAMP
          )
        )
      LIMIT 1
      FOR SHARE OF intent
    `);
    const origin = originRows.rows[0];
    if (origin) {
      return { ...origin, address: { account: selector.account } };
    }

    const mirrorRows = await tx.execute<{
      threadId: number;
      messageAccessAfterSeq: number;
      groupQueryDirection: 'MIRROR_TO_ORIGIN';
    }>(sql`
      SELECT thread.id AS "threadId",
        0 AS "messageAccessAfterSeq",
        'MIRROR_TO_ORIGIN' AS "groupQueryDirection"
      FROM "Group" group_state
      JOIN "MessageThread" thread ON thread."groupId" = group_state.id
      JOIN "AccountThreadState" local_state
        ON local_state."threadId" = thread.id
      JOIN "User" local_identity
        ON local_identity.id = local_state."accountId"
       AND local_identity.domain = 'local'
       AND local_identity."namespaceId" = 0
      JOIN "RelationshipPair" pair
        ON pair."threadId" = thread.id
       AND pair.kind = 'GROUP_MEMBER'
      JOIN "RelationshipIntent" intent
        ON intent."pairId" = pair.id
       AND (
         (pair."endpointAType" = 'GROUP'
          AND pair."endpointAAccount" = group_state.account
          AND pair."endpointADomain" = group_state.domain
          AND pair."endpointANamespaceId" = ${namespaceId}
          AND pair."endpointBType" = 'USER'
          AND pair."endpointBAccount" = local_identity.account
          AND pair."endpointBDomain" = 'local'
          AND pair."endpointBNamespaceId" = ${namespaceId}
          AND intent."authorSide" = 'B')
         OR
         (pair."endpointBType" = 'GROUP'
          AND pair."endpointBAccount" = group_state.account
          AND pair."endpointBDomain" = group_state.domain
          AND pair."endpointBNamespaceId" = ${namespaceId}
          AND pair."endpointAType" = 'USER'
          AND pair."endpointAAccount" = local_identity.account
          AND pair."endpointADomain" = 'local'
          AND pair."endpointANamespaceId" = ${namespaceId}
          AND intent."authorSide" = 'A')
       )
      WHERE thread.type = 'GROUP'
        AND group_state.account = ${selector.account}
        AND group_state.domain = ${peerDomain}
        AND group_state."namespaceId" = ${namespaceId}
        AND (
          intent.status = 'ACCEPTED'
          OR (
            intent.status = 'REQUESTED'
            AND intent."expiresAt" > CURRENT_TIMESTAMP
          )
        )
      LIMIT 1
      FOR SHARE OF intent
    `);
    const mirror = mirrorRows.rows[0];
    if (mirror) {
      return { ...mirror, address: { account: selector.account } };
    }
    return forbidden();
  }

  const rows = await tx.execute<{
    threadId: number;
    messageAccessAfterSeq: number;
    groupQueryDirection: null;
  }>(sql`
          SELECT pair."threadId" AS "threadId",
            COALESCE(audience."messageAccessAfterSeq", 0) AS "messageAccessAfterSeq",
            NULL AS "groupQueryDirection"
          FROM "RelationshipPair" pair
          JOIN "MessageThread" thread ON thread.id = pair."threadId"
          JOIN "RelationshipIntent" intent
            ON intent."pairId" = pair.id
           AND (
             (
               pair."endpointAType" = 'USER'
               AND pair."endpointAAccount" = ${selector.account}
               AND pair."endpointADomain" = 'local'
               AND pair."endpointANamespaceId" = ${namespaceId}
               AND pair."endpointBType" = 'USER'
               AND pair."endpointBAccount" = ${selector.peerAccount}
               AND pair."endpointBDomain" = ${peerDomain}
               AND pair."endpointBNamespaceId" = ${namespaceId}
               AND intent."authorSide" = 'A'
             ) OR (
               pair."endpointBType" = 'USER'
               AND pair."endpointBAccount" = ${selector.account}
               AND pair."endpointBDomain" = 'local'
               AND pair."endpointBNamespaceId" = ${namespaceId}
               AND pair."endpointAType" = 'USER'
               AND pair."endpointAAccount" = ${selector.peerAccount}
               AND pair."endpointADomain" = ${peerDomain}
               AND pair."endpointANamespaceId" = ${namespaceId}
               AND intent."authorSide" = 'B'
             )
           )
          LEFT JOIN "ThreadAudience" audience
            ON audience."threadId" = thread.id
           AND audience."targetDomain" = ${peerDomain}
           AND audience."targetNamespaceId" = ${namespaceId}
           AND audience."localUserId" IS NULL
          WHERE pair.kind = 'P2P'
            AND thread.type = 'P2P'
            AND (
              intent.status = 'ACCEPTED'
              OR (
                intent.status = 'REQUESTED'
                AND intent."expiresAt" > CURRENT_TIMESTAMP
              )
            )
          LIMIT 1
          FOR SHARE OF intent
        `);
  const authorized = rows.rows[0];
  if (!authorized) {
    return forbidden();
  }
  return {
    ...authorized,
    address: {
      account: selector.account,
      peerAccount: selector.peerAccount,
    },
  };
}

function forbidden(): never {
  throw new BusinessException(
    BusinessCode.FORBIDDEN,
    'the signed peer does not currently have access to this thread',
    HttpStatus.OK,
  );
}
