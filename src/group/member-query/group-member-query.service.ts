import { HttpStatus, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { BusinessCode } from '../../common/business-code.js';
import { BusinessException } from '../../common/business.exception.js';
import { DatabaseService } from '../../database/database.service.js';
import type {
  GroupMemberQueryItemDto,
  GroupMemberQueryPageDto,
  QueryGroupMembersDto,
} from '../../dto/group-member-query.dto.js';
import {
  decodeGroupMemberCursor,
  encodeGroupMemberCursor,
} from './group-member-query-cursor.js';

@Injectable()
export class GroupMemberQueryService {
  constructor(private readonly database: DatabaseService) {}

  async query(
    userId: number,
    input: QueryGroupMembersDto,
  ): Promise<GroupMemberQueryPageDto> {
    const scope = {
      threadId: input.threadId,
      search: (input.search ?? '').trim(),
      excludeSelf: input.excludeSelf ?? false,
    };
    const after = decodeGroupMemberCursor(input.cursor, scope);
    const take = input.take ?? 50;
    return this.database.db.transaction(
      async (tx) => {
        // Authorization and facts share one MVCC snapshot. Historical thread access
        // alone does not permit querying the current roster after revocation.
        const access = await tx.execute<{
          publisherNamespaceId: number;
          selfAccount: string;
          selfNamespaceId: number | null;
          clientMetaEndId: number | null;
        }>(sql`
        SELECT thread."authorityNamespaceId" AS "publisherNamespaceId",
          viewer.account AS "selfAccount",
          CASE WHEN thread."authorityNamespaceId" = 0 THEN 0
            ELSE publisher."peerAssignedLocalNamespaceId" END AS "selfNamespaceId",
          meta."clientMetaEndId"
        FROM "MessageThread" thread
        JOIN "Account" viewer ON viewer.id = ${userId}
        LEFT JOIN "GroupAccount" control ON control.id = thread."groupAccountId"
        LEFT JOIN "IdentityNamespace" publisher ON publisher.id = thread."authorityNamespaceId"
        LEFT JOIN "GroupMeta" meta ON meta."threadId" = thread.id
        WHERE thread.id = ${scope.threadId} AND thread.type = 'GROUP'
          AND COALESCE(control."dissolvedAt", thread."groupDissolvedAt") IS NULL
          AND EXISTS (
            SELECT 1 FROM "RelationshipPair" pair
            WHERE pair."threadId" = thread.id AND pair.kind = 'GROUP_MEMBER'
              AND pair.active = true AND (
                (pair."endpointAType" = 'USER' AND pair."endpointAAccount" = viewer.account
                  AND pair."endpointANamespaceId" = 0) OR
                (pair."endpointBType" = 'USER' AND pair."endpointBAccount" = viewer.account
                  AND pair."endpointBNamespaceId" = 0)))
      `);
        const group = access.rows[0];
        if (!group)
          throw new BusinessException(
            BusinessCode.FORBIDDEN,
            'group members are not visible to this user',
            HttpStatus.FORBIDDEN,
          );
        if (
          group.clientMetaEndId === null ||
          (group.publisherNamespaceId !== 0 &&
            (group.clientMetaEndId === 0 || group.selfNamespaceId === null))
        )
          throw new BusinessException(
            BusinessCode.GROUP_MEMBERS_NOT_READY,
            'group members are not ready; retry after synchronization',
            HttpStatus.OK,
          );

        // The existing thread/member-key index bounds candidates to one group;
        // immutable profile lookup uses its complete primary key. Search is literal
        // case-insensitive substring matching, not a LIKE pattern from the caller.
        const rows = await tx.execute<
          GroupMemberQueryItemDto & Record<string, unknown>
        >(sql`
        SELECT fact.body ->> 'account' AS account,
          ${group.publisherNamespaceId}::integer AS "publisherNamespaceId",
          (fact.body ->> 'namespaceId')::integer AS "profileNamespaceId",
          (fact.body ->> 'profileRev')::integer AS "profileRev",
          fact.body ->> 'role' AS role
        FROM "GroupMetaMemberFeed" fact
        LEFT JOIN "Profile" profile
          ON profile."publisherNamespaceId" = ${group.publisherNamespaceId}
          AND profile.account = fact.body ->> 'account'
          AND profile."profileNamespaceId" = (fact.body ->> 'namespaceId')::integer
          AND profile."profileRev" = (fact.body ->> 'profileRev')::integer
        WHERE fact."threadId" = ${scope.threadId} AND fact.operation = 'MEMBER_UPSERT'
          ${
            scope.excludeSelf
              ? sql`AND NOT (fact.body ->> 'account' = ${group.selfAccount}
            AND (fact.body ->> 'namespaceId')::integer = ${group.selfNamespaceId})`
              : sql.empty()
          }
          ${
            scope.search
              ? sql`AND (
            strpos(lower(fact.body ->> 'account'), lower(${scope.search}::text)) > 0
            OR strpos(lower(profile."displayName"), lower(${scope.search}::text)) > 0)`
              : sql.empty()
          }
          ${
            after
              ? sql`AND ( (fact.body ->> 'account') COLLATE "C",
            (fact.body ->> 'namespaceId')::integer ) > (
            ${after.account}::text COLLATE "C", ${after.profileNamespaceId}::integer )`
              : sql.empty()
          }
        ORDER BY (fact.body ->> 'account') COLLATE "C", (fact.body ->> 'namespaceId')::integer
        LIMIT ${take + 1}
      `);
        const items = rows.rows.slice(0, take);
        return {
          items,
          nextCursor:
            rows.rows.length > take
              ? encodeGroupMemberCursor(scope, items[items.length - 1]!)
              : null,
        };
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }
}
