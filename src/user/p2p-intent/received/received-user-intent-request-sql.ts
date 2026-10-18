import type { SQL } from 'drizzle-orm';
import {
  userIntentRequestStatement,
  type UserIntentRequestStateInput,
} from '../shared/user-intent-request-statement.js';

export interface ReceivedUserIntentRequestInput extends UserIntentRequestStateInput {
  authoredSql: SQL;
}

/** A received intent contains no local receiver presentation snapshot. */
export function receivedUserIntentRequestSql(input: ReceivedUserIntentRequestInput) {
  return userIntentRequestStatement(input, input.authoredSql);
}
