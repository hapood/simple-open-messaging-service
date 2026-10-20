import { sql, type SQL } from 'drizzle-orm';
import {
  mirrorGroupDirection,
  mirrorIntentReadBackSql,
  mirrorIntentWriteSql,
  type MirrorGroupPresentationInput,
} from './mirror-membership-shared-sql.js';

export interface MirrorMembershipRequestInput {
  threadId: number;
  presentation: MirrorGroupPresentationInput;
  memberAccount: string;
  localMemberId: number;
  /** Wire coordinates from the received item body. */
  intent: {
    profileNamespaceId: number;
    profileRev: number;
    note: string;
    requestedAt: Date;
    expiresAt: Date;
    messageEndSeq: number;
    tombstoneEndSeq: number;
  };
}

/** One composed statement for a received REQUESTED that does not activate: the
 * stranger branch (the preamble minted the inactive canonical pair, this
 * statement persists side A) and the refresh branch (side B REVOKED or expired
 * — side B stays untouched so re-application keeps working). Activating
 * collapses route to the acceptance statement instead. Request history belongs
 * to the permanent request capability; this statement writes no client event. */
export function mirrorMembershipRequestSql(
  input: MirrorMembershipRequestInput,
): SQL {
  const { author, receiver } = mirrorGroupDirection(
    input.presentation,
    input.memberAccount,
  );
  return sql`
    WITH authored AS (
      ${mirrorIntentWriteSql({
        author,
        receiver,
        status: 'REQUESTED',
        note: input.intent.note,
        requestedAt: input.intent.requestedAt,
        expiresAt: input.intent.expiresAt,
        profileNamespaceId: input.intent.profileNamespaceId,
        profileRev: input.intent.profileRev,
        messageEndSeq: input.intent.messageEndSeq,
        tombstoneEndSeq: input.intent.tombstoneEndSeq,
      })}
    ), ${mirrorIntentReadBackSql({
      writeName: 'authored',
      readBackName: 'persisted_intent',
      author,
      receiver,
    })}
    SELECT EXISTS (SELECT 1 FROM authored) AS "intentChanged"
    FROM persisted_intent v
  `;
}
