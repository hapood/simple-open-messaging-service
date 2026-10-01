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
  | (GroupMetaFeedItemBase & {
      operation: 'MEMBER_DEPART';
      body: Record<string, unknown>;
    })
  | {
      feedId: number;
      operation: 'GROUP_PROFILE';
      body: { namespaceId: number; profileRev: number };
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
  constructor(private readonly database: DatabaseService) {}

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
              eq(threadAudience.targetNamespaceId, namespaceId),
              eq(threadAudience.targetNamespaceId, namespaceId),
              sql`${threadAudience.localUserId} IS NULL`,
            ),
          )
          .limit(1);
        const page = await readGroupMetaPageInTx(tx, {
          groupId: source.groupId,
          account,
          viewMode: 'federation',
          feedMode: mode,
          after,
          take,
          through,
          end: feed?.metaEndId ?? 0,
          visibleAfter: audience?.visibleAfter ?? 0,
        });
        return {
          ...page,
          items: page.items.map((item): GroupMetaFeedItem => {
            if (item.operation === 'GROUP_PROFILE')
              return {
                feedId: item.feedId,
                operation: 'GROUP_PROFILE',
                body: {
                  namespaceId: item.body.profileNamespaceId,
                  profileRev: item.body.profileRev,
                },
              };
            if (
              item.operation === 'MEMBER_UPSERT' ||
              item.operation === 'MEMBER_DEPART'
            ) {
              const { profileNamespaceId, ...body } = item.body;
              return {
                ...item,
                body: {
                  ...body,
                  namespaceId: Number(profileNamespaceId),
                },
              };
            }
            return item;
          }),
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
