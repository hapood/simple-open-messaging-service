import { sql, type SQL } from 'drizzle-orm';
import {
  userIntentPeerWriteSql,
  type UserIntentFeedInput,
} from '../authored/user-intent-peer-feed-sql.js';

export interface UserIntentRequestStateInput extends UserIntentFeedInput {
  note: string;
  requestedAt: Date;
  expiresAt: Date;
}

/** One composed statement for a fresh or refreshed REQUESTED direction. It
 * authors the actor's intent; a peer-hosted target receives the actor's direction
 * with the thread head snapshot. No activation, no audience, no system
 * message: friendship effects wait for the confirm/accept paths. */
export function userIntentRequestStatement(input: UserIntentRequestStateInput, intentWrite: SQL): SQL {
  const remote = input.targetNamespaceId !== 0;
  return sql`
    WITH authored AS (
      ${intentWrite}
    ), request_state AS MATERIALIZED (
      SELECT "authorAccount", "authorNamespaceId", status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt" FROM authored
      UNION ALL
      SELECT "authorAccount", "authorNamespaceId", status, "profileNamespaceId", "profileRev", note, "requestedAt", "expiresAt"
      FROM "RelationshipIntent"
      WHERE "authorAccount" = ${input.actorAccount} AND "authorNamespaceId" = ${input.actorNamespaceId}
        AND "receiverAccount" = ${input.targetAccount} AND "receiverNamespaceId" = ${input.targetNamespaceId}
        AND NOT EXISTS (SELECT 1 FROM authored)
    )${
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
      ${remote ? sql`(SELECT max("feedId") FROM peer_result)` : sql`NULL::text`} AS "peerFeedId"
    FROM request_state v
  `;
}
