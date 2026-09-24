import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { groupMeta, threadAudience } from '../database/schema.js';
import { DatabaseService } from '../database/database.service.js';
import {
  groupState as group,
  groupStateFields,
} from '../group/shared/group-state.js';
import { readGroupMetaPageInTx } from '../group/meta/group-meta-page.js';
import { loadFederationConfig } from './federation.config.js';
import { resolveAuthorizedFederationThreadInTx } from './federation-thread-query-authorization.js';

interface GroupMetaFeedItemBase {
  feedId: number;
  account: string;
  domain: string;
}

export type GroupMetaFeedItem =
  | (GroupMetaFeedItemBase & {
      operation: 'MEMBER_UPSERT';
      body: Record<string, unknown>;
    })
  | (GroupMetaFeedItemBase & { operation: 'MEMBER_DEPART' })
  | {
      feedId: number;
      operation: 'GROUP_PROFILE';
      body: { profileRev: number };
    }
  | {
      feedId: number;
      operation: 'GROUP_ANNOUNCEMENT';
      body: { text: string | null };
    };

export interface GroupMetaFeedPage {
  account: string;
  mode: 'full' | 'delta';
  items: GroupMetaFeedItem[];
  scannedThrough: number;
  groupMetaFeedEndId: number;
  hasMore: boolean;
}

const DEFAULT_TAKE = 100;

@Injectable()
export class FederationGroupMetaFeedService {
  private readonly ourDomain = loadFederationConfig().domain;

  constructor(private readonly database: DatabaseService) {}

  async resolveProfileReference(
    peerDomain: string,
    namespaceId: number,
    groupAccount: string,
    subject:
      | { type: 'GROUP' }
      | { type: 'MEMBER'; account: string; domain: string },
  ): Promise<{
    account: string;
    domain: string;
    namespaceId: number;
    profileRev: number;
  } | null> {
    try {
      return await this.database.db.transaction(
        async (tx) => {
          const authorized = await resolveAuthorizedFederationThreadInTx(
            tx,
            peerDomain,
            namespaceId,
            { type: 'GROUP', account: groupAccount },
          );
          if (authorized.groupQueryDirection !== 'ORIGIN_DISTRIBUTION')
            return null;
          const [source] = await tx
            .select({
              groupId: group.id,
              account: groupStateFields.account,
              profileRev: groupStateFields.profileRev,
            })
            .from(group)
            .where(
              and(
                eq(groupStateFields.account, groupAccount),
                eq(groupStateFields.domain, 'local'),
                eq(groupStateFields.namespaceId, 0),
              ),
            )
            .limit(1);
          if (!source) return null;
          if (subject.type === 'GROUP') {
            if (source.profileRev < 1) return null;
            return {
              account: source.account,
              domain: this.ourDomain,
              namespaceId: 0,
              profileRev: source.profileRev,
            };
          }
          const storedMemberDomain =
            subject.domain === this.ourDomain ? 'local' : subject.domain;
          const rows = await tx.execute<{
            namespaceId: number;
            profileRev: number;
          }>(sql`
            SELECT group_meta_member_namespace(member_fact."threadId",
              member_fact."memberAccount", member_fact."memberDomain") AS "namespaceId",
              (member_fact.body ->> 'profileRev')::integer AS "profileRev"
            FROM "GroupMetaMemberFeed" member_fact
            WHERE member_fact."threadId" = ${source.groupId}
              AND member_fact."memberAccount" = ${subject.account}
              AND member_fact."memberDomain" = ${storedMemberDomain}
              AND member_fact.operation = 'MEMBER_UPSERT'
            ORDER BY member_fact."feedId" DESC
            LIMIT 1
          `);
          const reference = rows.rows[0];
          if (!reference || reference.profileRev < 1) return null;
          return {
            account: subject.account,
            domain: subject.domain,
            namespaceId: reference.namespaceId,
            profileRev: reference.profileRev,
          };
        },
        { isolationLevel: 'repeatable read', accessMode: 'read only' },
      );
    } catch (error) {
      if (
        error instanceof BusinessException &&
        error.bizCode === BusinessCode.FORBIDDEN
      )
        return null;
      throw error;
    }
  }

  async serve(
    peerDomain: string,
    namespaceId: number,
    account: string,
    mode: 'full' | 'delta',
    after: number | undefined,
    take = DEFAULT_TAKE,
    through?: number,
  ): Promise<GroupMetaFeedPage> {
    return this.database.db.transaction(
      async (tx) => {
        const authorized = await resolveAuthorizedFederationThreadInTx(
          tx,
          peerDomain,
          namespaceId,
          { type: 'GROUP', account },
        );
        if (authorized.groupQueryDirection !== 'ORIGIN_DISTRIBUTION')
          throw new BusinessException(
            BusinessCode.FORBIDDEN,
            'group meta is not visible to this peer',
            HttpStatus.OK,
          );
        const [source] = await tx
          .select({ groupId: group.id })
          .from(group)
          .where(
            and(
              eq(groupStateFields.account, account),
              eq(groupStateFields.domain, 'local'),
              eq(groupStateFields.namespaceId, 0),
            ),
          )
          .limit(1);
        if (!source)
          throw new BusinessException(
            BusinessCode.FORBIDDEN,
            'group meta is not visible to this peer',
            HttpStatus.OK,
          );
        const [feed] = await tx
          .select({ metaEndId: groupMeta.metaEndId })
          .from(groupMeta)
          .where(eq(groupMeta.threadId, source.groupId))
          .limit(1);
        const [audience] = await tx
          .select({ visibleAfter: threadAudience.groupMetaVisibleAfter })
          .from(threadAudience)
          .where(
            and(
              eq(threadAudience.threadId, authorized.threadId),
              eq(threadAudience.targetDomain, peerDomain),
              eq(threadAudience.targetNamespaceId, namespaceId),
              sql`${threadAudience.localUserId} IS NULL`,
            ),
          )
          .limit(1);
        const page = await readGroupMetaPageInTx(tx, {
          groupId: source.groupId,
          account,
          mode,
          after,
          take,
          through,
          end: feed?.metaEndId ?? 0,
          visibleAfter: audience?.visibleAfter ?? 0,
        });
        return {
          ...page,
          items: page.items.map((item) =>
            'domain' in item && item.domain === 'local'
              ? { ...item, domain: this.ourDomain }
              : item,
          ),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
