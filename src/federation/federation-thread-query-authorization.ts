import { groupStateSql } from '../group/shared/group-state.js';
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
 * authoritative server; it is not the authorization fact. Authorization and page data share a
 * read-only MVCC snapshot. Revocations do not wait for readers; receiving writers reject stale
 * rounds through their epoch gate.
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
      FROM ${groupStateSql} group_state
      JOIN "MessageThread" thread ON thread.id = group_state.id
      JOIN "RelationshipPair" pair
        ON pair."threadId" = thread.id
       AND pair.kind = 'GROUP_MEMBER'
       AND pair."endpointAType" = 'GROUP'
       AND pair."endpointAAccount" = group_state.account
       AND pair."endpointANamespaceId" = 0
       AND pair."endpointBType" = 'USER'
       AND pair."endpointBNamespaceId" = ${namespaceId}
      JOIN "RelationshipIntent" intent
        ON intent."authorAccount" = pair."endpointAAccount"
       AND intent."authorNamespaceId" = pair."endpointANamespaceId"
       AND intent."receiverAccount" = pair."endpointBAccount"
       AND intent."receiverNamespaceId" = pair."endpointBNamespaceId"
      LEFT JOIN "ThreadAudience" audience
        ON audience."threadId" = thread.id
       AND audience."targetNamespaceId" = ${namespaceId}
       AND audience."targetNamespaceId" = ${namespaceId}
       AND audience."localUserId" IS NULL
      WHERE thread.type = 'GROUP'
        AND group_state.account = ${selector.account}
        AND group_state."namespaceId" = 0
        AND (
          intent.status = 'ACCEPTED'
          OR (
            intent.status = 'REQUESTED'
            AND intent."expiresAt" > CURRENT_TIMESTAMP
          )
        )
      LIMIT 1

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
      FROM ${groupStateSql} group_state
      JOIN "MessageThread" thread ON thread.id = group_state.id
      JOIN "AccountThreadState" local_state
        ON local_state."threadId" = thread.id
      JOIN "Account" local_identity
        ON local_identity.id = local_state."accountId"
       AND local_identity."namespaceId" = 0
      JOIN "RelationshipPair" pair
        ON pair."threadId" = thread.id
       AND pair.kind = 'GROUP_MEMBER'
       AND pair."endpointAType" = 'USER'
       AND pair."endpointAAccount" = local_identity.account
       AND pair."endpointANamespaceId" = 0
       AND pair."endpointBType" = 'GROUP'
       AND pair."endpointBAccount" = group_state.account
       AND pair."endpointBNamespaceId" = ${namespaceId}
      JOIN "RelationshipIntent" intent
        ON intent."authorAccount" = pair."endpointBAccount"
       AND intent."authorNamespaceId" = pair."endpointBNamespaceId"
       AND intent."receiverAccount" = pair."endpointAAccount"
       AND intent."receiverNamespaceId" = pair."endpointANamespaceId"
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
            ON (
              (
                intent."authorAccount" = pair."endpointAAccount"
                AND intent."authorNamespaceId" = pair."endpointANamespaceId"
                AND intent."receiverAccount" = pair."endpointBAccount"
                AND intent."receiverNamespaceId" = pair."endpointBNamespaceId"
              )
              OR (
                intent."authorAccount" = pair."endpointBAccount"
                AND intent."authorNamespaceId" = pair."endpointBNamespaceId"
                AND intent."receiverAccount" = pair."endpointAAccount"
                AND intent."receiverNamespaceId" = pair."endpointANamespaceId"
              )
            )
          LEFT JOIN "ThreadAudience" audience
            ON audience."threadId" = thread.id
           AND audience."targetNamespaceId" = ${namespaceId}
           AND audience."targetNamespaceId" = ${namespaceId}
           AND audience."localUserId" IS NULL
          WHERE pair.kind = 'P2P'
            AND pair.active = true
            AND thread.type = 'P2P'
            AND pair."endpointANamespaceId" = 0
        AND pair."endpointBType" = 'USER'
        AND pair."endpointBAccount" = ${selector.peerAccount}
        AND pair."endpointBNamespaceId" = ${namespaceId}
            AND (
              intent.status = 'ACCEPTED'
              OR (
                intent.status = 'REQUESTED'
                AND intent."expiresAt" > CURRENT_TIMESTAMP
              )
            )
          LIMIT 1

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
