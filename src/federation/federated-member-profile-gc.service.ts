import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import { mutuallyAuthorizedSql } from '../invite/relationship-authorization.js';
import { loadFederationConfig } from './federation.config.js';

/** Collects federated member profiles after their authorized group references disappear. */
@Injectable()
export class FederatedMemberProfileGcService {
  private readonly config = loadFederationConfig();

  constructor(private readonly database: DatabaseService) {}

  async sweepSourcePeer(sourcePeerDomain: string): Promise<void> {
    await this.deleteUnreferencedInTx(this.database.db, sourcePeerDomain);
  }

  async deleteProfileIfUnreferencedInTx(
    tx: DatabaseTransaction,
    params: {
      sourcePeerDomain: string;
      memberAccount: string;
      memberDomain: string;
    },
  ): Promise<void> {
    await this.deleteUnreferencedInTx(
      tx,
      params.sourcePeerDomain,
      sql`AND candidate."memberAccount" = ${params.memberAccount}
          AND candidate."memberDomain" = ${params.memberDomain}`,
    );
  }

  private async deleteUnreferencedInTx(
    executor: Pick<DatabaseTransaction, 'execute'>,
    sourcePeerDomain: string,
    candidateFilter = sql``,
  ): Promise<void> {
    await executor.execute(sql`
      DELETE FROM "FederatedMemberProfile" candidate
      WHERE candidate."sourcePeerDomain" = ${sourcePeerDomain}
        ${candidateFilter}
        AND NOT EXISTS (
          SELECT 1
          FROM "ThreadParticipant" participant
          JOIN "User" member_user ON member_user.id = participant."userId"
          JOIN "MessageThread" thread ON thread.id = participant."threadId"
            AND thread.type = 'GROUP'
          JOIN "User" group_user ON group_user.id = thread."groupUserId"
            AND group_user.domain = ${sourcePeerDomain}
          WHERE ${mutuallyAuthorizedSql(sql`participant."userId"`, sql`thread."groupUserId"`)}
            AND member_user.account = candidate."memberAccount"
            AND (CASE WHEN member_user.domain = 'local'
                      THEN ${this.config.domain}
                      ELSE member_user.domain END) = candidate."memberDomain"
        )
    `);
  }
}
