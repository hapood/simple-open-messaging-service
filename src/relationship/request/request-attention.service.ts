import { Injectable } from '@nestjs/common';
import { and, eq, gt, gte, inArray, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service.js';
import { account, accountThreadState } from '../../database/schema.js';

/** Request attention is independent of message unread counts and sequences. */
@Injectable()
export class RequestAttentionService {
  constructor(private readonly database: DatabaseService) {}

  async hasUnread(
    userId: number,
    scope: { personal: boolean; managedGroups: boolean },
  ): Promise<boolean> {
    if (scope.personal) {
      const rows = await this.database.db
        .select({ id: account.id })
        .from(account)
        .where(
          and(
            eq(account.id, userId),
            gt(account.requestEndId, account.requestReadId),
          ),
        )
        .limit(1);
      if (rows.length) return true;
    }
    if (scope.managedGroups) {
      const rows = await this.database.db
        .select({ id: accountThreadState.id })
        .from(accountThreadState)
        .where(
          and(
            eq(accountThreadState.accountId, userId),
            inArray(accountThreadState.role, ['OWNER', 'ADMIN']),
            isNull(accountThreadState.messageVisibleThroughSeq),
            gte(accountThreadState.joinRequestReadFeedId, 0),
            gt(
              accountThreadState.joinRequestEndFeedId,
              accountThreadState.joinRequestReadFeedId,
            ),
          ),
        )
        .limit(1);
      if (rows.length) return true;
    }
    return false;
  }
}
