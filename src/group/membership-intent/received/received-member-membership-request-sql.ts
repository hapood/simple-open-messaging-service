import type { SQL } from 'drizzle-orm';
import {
  memberMembershipRequestStatement,
  type MemberMembershipRequestStateInput,
} from '../shared/member-membership-request-statement.js';

export interface ReceivedMemberMembershipRequestInput
  extends MemberMembershipRequestStateInput {
  authoredSql: SQL;
}

/** Received applications contain no sender-local target snapshot. */
export function receivedMemberMembershipRequestSql(
  input: ReceivedMemberMembershipRequestInput,
) {
  return memberMembershipRequestStatement(input, input.authoredSql);
}
