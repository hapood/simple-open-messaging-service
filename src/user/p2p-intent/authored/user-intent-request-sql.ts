import { sql, type SQL } from 'drizzle-orm';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import {
  userIntentClientBodiesSql,
  userIntentPeerWriteSql,
  type UserIntentFeedInput,
} from './user-intent-client-feed-sql.js';

export interface UserIntentRequestInput extends UserIntentFeedInput {
  note: string;
  requestedAt: Date;
  expiresAt: Date;
  /** Alternate validated writer used by received peer intents. */
  authoredSql?: SQL;
}

/** One composed statement for a fresh or refreshed REQUESTED direction. It
 * authors the actor's intent and publishes both current directions to the local
 * endpoints; a peer-hosted target additionally receives the actor's direction
 * with the thread head snapshot. No activation, no audience, no system
 * message: friendship effects wait for the confirm/accept paths. */
export function userIntentRequestSql(input: UserIntentRequestInput): SQL {
  const remote = input.targetNamespaceId !== 0;
  const authoredSql =
    input.authoredSql ??
    authoredIntentWriteSql({
      author: {
        account: input.actorAccount,
        namespaceId: input.actorNamespaceId,
      },
      receiver: {
        account: input.targetAccount,
        namespaceId: input.targetNamespaceId,
      },
      threadId: input.threadId,
      status: 'REQUESTED',
      note: input.note,
      requestedAt: input.requestedAt,
      expiresAt: input.expiresAt,
    });
  return sql`
    WITH authored AS (
      ${authoredSql}
    ), request_state AS MATERIALIZED (
      SELECT "authorAccount", "authorNamespaceId", status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT "authorAccount", "authorNamespaceId", status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.actorAccount} AND "authorNamespaceId" = ${input.actorNamespaceId}
        AND "receiverAccount" = ${input.targetAccount} AND "receiverNamespaceId" = ${input.targetNamespaceId}
        AND NOT EXISTS (SELECT 1 FROM authored)
    ), ${userIntentClientBodiesSql({ ...input, ownState: 'request_state' })}${
      remote
        ? sql`, ${userIntentPeerWriteSql({
            ...input,
            ownState: 'request_state',
            revoked: false,
            always: false,
            resultName: 'peer_result',
          })}`
        : sql``
    }
    SELECT v.status, v.note,
      EXISTS (SELECT 1 FROM authored) AS "intentChanged",
      COALESCE((SELECT jsonb_agg(jsonb_build_object('userId', r."userId", 'feedId', r."feedId")
        ORDER BY r."userId") FROM recipient_result r), '[]'::jsonb) AS "clientUpdates",
      ${remote ? sql`(SELECT max("feedId") FROM peer_result)` : sql`NULL::text`} AS "peerFeedId"
    FROM request_state v
  `;
}
