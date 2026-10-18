import type { RequestSnapshot } from '../../../../shared/request-snapshot.js';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import {
  memberMembershipRequestStatement,
  type MemberMembershipRequestStateInput,
} from '../shared/member-membership-request-statement.js';

export interface MemberAuthoredMembershipRequestInput extends MemberMembershipRequestStateInput {
  snapshot: RequestSnapshot;
}

/** Local applications always carry their send-time group presentation. */
export function memberAuthoredMembershipRequestSql(input: MemberAuthoredMembershipRequestInput) {
  return memberMembershipRequestStatement(input, authoredIntentWriteSql({
    author: { account: input.memberAccount, namespaceId: input.profileNamespaceId },
    receiver: { account: input.groupAccount, namespaceId: 0 },
    threadId: input.threadId,
    status: 'REQUESTED',
    note: input.note,
    requestedAt: input.requestedAt,
    expiresAt: input.expiresAt,
    snapshot: input.snapshot,
  }));
}
