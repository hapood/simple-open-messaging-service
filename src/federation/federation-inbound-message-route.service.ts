import { HttpStatus, Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { isThreadMutuallyAuthorized } from '../invite/relationship-authorization.js';
import { upsertSourceUserInTx } from '../user/source-user.js';
import type { S2SAddress } from './federation-address.js';
import { loadFederationConfig } from './federation.config.js';
import { FederationMessageContextError } from './federation-errors.js';
import type {
  FederationMessageFeedMessage,
  FederationThreadAddress,
} from './federation-message-feed.service.js';

export interface FederationInboundMessageRoute {
  threadId: number;
  creatorAccount: string;
  creatorDomain: string;
  federationVersion: number;
  recipients: number[];
  toAccount: string;
}

export interface FederationInboundTombstoneRoute {
  threadId: number;
  federationVersion: number;
  recipients: number[];
  groupOriginDomain?: string;
}

/** Resolves authenticated wire thread coordinates to retained local federation threads. */
@Injectable()
export class FederationInboundMessageRouteService {
  private readonly config = loadFederationConfig();

  messageAuthor(
    item: FederationMessageFeedMessage,
    sourceDomain: string,
  ): S2SAddress {
    if ('authorRef' in item) {
      return item.authorRef === 'THREAD_ACCOUNT'
        ? { account: item.thread.account, domain: sourceDomain }
        : {
            account: item.thread.peerAccount,
            domain: this.config.domain,
          };
    }
    return item.author.domain === 'local'
      ? { account: item.author.account, domain: sourceDomain }
      : item.author;
  }

  async resolveMessage(
    tx: DatabaseTransaction,
    item: FederationMessageFeedMessage,
    sourceDomain: string,
    namespaceId: number,
  ): Promise<FederationInboundMessageRoute> {
    let threadRows: Array<{
      threadId: number;
      federationVersion: number;
      toAccount: string;
    }> = [];
    if (!('peerAccount' in item.thread)) {
      const result = await tx.execute<{
        threadId: number;
        federationVersion: number;
        toAccount: string;
      }>(sql`
        SELECT thread.id AS "threadId",
               thread."federationVersion",
               group_user.account AS "toAccount"
        FROM "MessageThread" thread
        JOIN "Group" group_user ON group_user.id = thread."groupId"
        WHERE thread.type = 'GROUP'
          AND group_user.account = ${normalizeAccount(item.thread.account)}
          AND group_user.domain = ${sourceDomain}
          AND group_user."namespaceId" = ${namespaceId}
        LIMIT 1
        FOR SHARE OF thread
      `);
      threadRows = result.rows;
    } else {
      const author = this.messageAuthor(item, sourceDomain);
      const selfAuthored = author.domain === this.config.domain;
      const expectedAuthorAccount = selfAuthored
        ? item.thread.peerAccount
        : item.thread.account;
      if (
        normalizeAccount(author.account) !==
        normalizeAccount(expectedAuthorAccount)
      ) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'invalid P2P missed route',
          HttpStatus.BAD_REQUEST,
        );
      }
      const result = await tx.execute<{
        threadId: number;
        federationVersion: number;
        toAccount: string;
      }>(sql`
        SELECT thread.id AS "threadId",
               thread."federationVersion",
               local_user.account AS "toAccount"
        FROM "MessageThread" thread
        JOIN "ThreadMember" local_member ON local_member."threadId" = thread.id
        JOIN "User" local_user ON local_user.id = local_member."userId"
        JOIN "ThreadParticipant" local_participant
          ON local_participant."threadId" = thread.id
         AND local_participant."accountId" = local_user.id
        JOIN "ThreadMember" remote_member ON remote_member."threadId" = thread.id
        JOIN "User" remote_user ON remote_user.id = remote_member."userId"
        WHERE thread.type = 'P2P'
          AND local_user.domain = 'local'
          AND local_user."namespaceId" = 0
          AND local_user.account = ${normalizeAccount(item.thread.peerAccount)}
          AND local_member."left" = false
          AND remote_user.domain = ${sourceDomain}
          AND remote_user."namespaceId" = ${namespaceId}
          AND remote_user.account = ${normalizeAccount(item.thread.account)}
          AND remote_member."left" = false
        LIMIT 1
        FOR SHARE OF thread, local_member, remote_member
      `);
      threadRows = result.rows;
    }
    const route = threadRows[0];
    if (!route) {
      throw new FederationMessageContextError(
        'missed message has no retained local thread',
      );
    }
    const author = this.messageAuthor(item, sourceDomain);
    const creatorAccount = normalizeAccount(author.account);
    const creatorDomain =
      author.domain === this.config.domain ? 'local' : author.domain;
    if (
      !('peerAccount' in item.thread) &&
      author.domain !== this.config.domain
    ) {
      const normalizedAuthor = normalizeAccount(author.account);
      const existingAuthor = await tx.query.user.findFirst({
        where: and(
          eq(tables.user.account, normalizedAuthor),
          eq(tables.user.domain, author.domain),
          eq(tables.user.sourceDomain, sourceDomain),
          eq(tables.user.namespaceId, namespaceId),
        ),
        columns: { id: true },
      });
      const authorId =
        existingAuthor?.id ??
        (await upsertSourceUserInTx(tx, {
          account: normalizedAuthor,
          domain: author.domain,
          sourceDomain,
          namespaceId,
          name: normalizedAuthor,
          profileRev: 0,
        }));
      await tx
        .insert(tables.threadMember)
        .values({
          threadId: route.threadId,
          userId: authorId,
          role: null,
          left: true,
          updatedAt: new Date(),
        })
        .onConflictDoNothing();
    }
    const recipientRows =
      'peerAccount' in item.thread
        ? await tx.execute<{ userId: number }>(sql`
            SELECT participant."accountId" AS "userId"
            FROM "ThreadParticipant" participant
            WHERE participant."threadId" = ${route.threadId}
            FOR SHARE OF participant
          `)
        : await tx.execute<{ userId: number }>(sql`
            SELECT audience."localUserId" AS "userId"
            FROM "ThreadAudience" audience
            WHERE audience."threadId" = ${route.threadId}
              AND audience."targetDomain" = 'local'
              AND audience."localUserId" IS NOT NULL
            FOR SHARE OF audience
          `);
    return {
      ...route,
      creatorAccount,
      creatorDomain,
      recipients: recipientRows.rows.map((row) => row.userId),
    };
  }

  async resolveTombstone(
    tx: DatabaseTransaction,
    thread: FederationThreadAddress,
    sourceDomain: string,
    namespaceId: number,
  ): Promise<FederationInboundTombstoneRoute> {
    if ('peerAccount' in thread) {
      return this.resolveMessage(
        tx,
        { thread, authorRef: 'THREAD_ACCOUNT' } as FederationMessageFeedMessage,
        sourceDomain,
        namespaceId,
      );
    }

    const rows = await tx.execute<{
      threadId: number;
      federationVersion: number;
      groupDomain: string;
    }>(sql`
      SELECT message_thread.id AS "threadId",
             message_thread."federationVersion",
             group_user.domain AS "groupDomain"
      FROM "MessageThread" message_thread
      JOIN "Group" group_user ON group_user.id = message_thread."groupId"
      WHERE message_thread.type = 'GROUP'
        AND group_user.account = ${normalizeAccount(thread.account)}
        AND group_user."namespaceId" = ${namespaceId}
      LIMIT 1
      FOR SHARE OF message_thread
    `);
    const route = rows.rows[0];
    if (!route) {
      throw new FederationMessageContextError(
        'tombstone has no retained local group thread',
      );
    }
    const recipientRows = await tx.execute<{ userId: number }>(sql`
      SELECT participant."accountId" AS "userId"
      FROM "ThreadParticipant" participant
      WHERE participant."threadId" = ${route.threadId}
      FOR SHARE OF participant
    `);
    const recipientAuthorization = await Promise.all(
      recipientRows.rows.map((row) =>
        isThreadMutuallyAuthorized(tx, row.userId, route.threadId),
      ),
    );
    return {
      ...route,
      groupOriginDomain:
        route.groupDomain === 'local' ? this.config.domain : route.groupDomain,
      recipients: recipientRows.rows
        .filter((_, index) => recipientAuthorization[index])
        .map((row) => row.userId),
    };
  }
}
