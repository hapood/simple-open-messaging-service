import { businessEnvelope } from '../common/api-result.js';
import { isBusinessRejection } from '../common/business-command-result.js';
import type { MemberAuthoredGroupMembershipIntentService } from '../group/membership-intent/authored/member-authored-group-membership-intent.service.js';
import type { RelationshipRequestService } from '../relationship/request/relationship-request.service.js';
import type { RequestDecision } from '../../shared/relationship-request.js';

/** Shared controller orchestration for a member-side exact-round group
 * decision: the round resolves the addressed member and thread, then the
 * member-authored membership state machine settles it with the exact-round
 * gate under its locks. Both the group routes and the personal
 * relationship-request routes (whose SENT/RECEIVED pages surface group rounds
 * beside FRIEND rounds) delegate here. */
export async function decideMemberGroupRound(
  deps: {
    requests: Pick<RelationshipRequestService, 'resolveMemberGroupRound'>;
    memberIntents: Pick<MemberAuthoredGroupMembershipIntentService, 'execute'>;
  },
  userId: number,
  requestId: string,
  decision: RequestDecision,
) {
  const resolution = await deps.requests.resolveMemberGroupRound(
    userId,
    requestId,
    decision,
  );
  if (resolution.status === 'STALE_REQUEST') return resolution;
  const outcome = await deps.memberIntents.execute(
    {
      threadId: resolution.threadId,
      memberUserId: userId,
      decision: decision === 'ACCEPT' ? 'ACCEPTED' : 'REVOKED',
    },
    {
      requestDecision: {
        requestId: BigInt(requestId),
        decision,
      },
    },
  );
  if (outcome.status === 'STALE_REQUEST' || outcome.status === 'EXPIRED')
    return outcome;
  if (isBusinessRejection(outcome))
    return businessEnvelope(outcome.code, outcome.message, {
      status: outcome.status,
      reason: outcome.reason,
    });
  return { status: 'OK', threadId: resolution.threadId };
}
