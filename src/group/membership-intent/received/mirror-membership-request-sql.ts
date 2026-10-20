import type { SQL } from 'drizzle-orm';
import {
  mirrorGroupDirection,
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

/** The received side A REQUESTED wire write for a request that does not
 * activate: the stranger branch (the preamble minted the inactive canonical
 * pair) and the refresh branch (side B REVOKED or expired — side B stays
 * untouched so re-application keeps working). Activating collapses route to
 * the activation family instead. Request history belongs to the permanent
 * request capability; no client event is written here. The guarded RETURNING
 * reports whether this delivery moved the mirrored group direction. */
export function mirrorMembershipRequestIntentWrite(
  input: MirrorMembershipRequestInput,
): SQL {
  const { author, receiver } = mirrorGroupDirection(
    input.presentation,
    input.memberAccount,
  );
  return mirrorIntentWriteSql({
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
  });
}
