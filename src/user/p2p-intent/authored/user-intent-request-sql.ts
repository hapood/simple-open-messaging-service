import type { RequestSnapshot } from '../../../../shared/request-snapshot.js';
import { authoredIntentWriteSql } from '../../../common/sql/authored-relationship-intent-sql.js';
import {
  userIntentRequestStatement,
  type UserIntentRequestStateInput,
} from '../shared/user-intent-request-statement.js';

export interface UserIntentRequestInput extends UserIntentRequestStateInput {
  snapshot: RequestSnapshot;
  requestId?: bigint | null;
}

/** Local requests always capture the receiver's send-time presentation. */
export function userIntentRequestSql(input: UserIntentRequestInput) {
  return userIntentRequestStatement(
    input,
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
      statusChangedAt: input.statusChangedAt,
      expiresAt: input.expiresAt,
      requestId: input.requestId,
      snapshot: input.snapshot,
    }),
  );
}
