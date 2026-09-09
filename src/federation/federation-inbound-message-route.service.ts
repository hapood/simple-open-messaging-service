import { groupStateSql } from '../group/group-state.js';
import { HttpStatus, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { isThreadMutuallyAuthorized } from '../relationship/relationship-authorization.js';
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
  memberSubmission?: boolean;
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
    const author = this.messageAuthor(item, sourceDomain);
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
        JOIN ${groupStateSql} group_user ON group_user.id = thread.id
        WHERE thread.type = 'GROUP'
          AND group_user.account = ${normalizeAccount(item.thread.account)}
          AND group_user.domain = ${sourceDomain}
          AND group_user."namespaceId" = ${namespaceId}
        LIMIT 1
        FOR SHARE OF thread
      `);
      threadRows = result.rows;
      if (threadRows.length === 0 && author.domain !== sourceDomain) {
        throw new BusinessException(
          BusinessCode.FEDERATION_MALFORMED,
          'group mirror may only submit its locally managed authors',
          HttpStatus.BAD_REQUEST,
        );
      }
      const remoteMemberAccount = normalizeAccount(author.account);
      if (threadRows.length === 0) {
        const memberResult = await tx.execute<{
          threadId: number;
          federationVersion: number;
          toAccount: string;
        }>(sql`
          SELECT thread.id AS "threadId",
                 thread."federationVersion",
                 group_user.account AS "toAccount"
          FROM "RelationshipPair" pair
          JOIN "MessageThread" thread ON thread.id = pair."threadId"
          JOIN ${groupStateSql} group_user ON group_user.id = thread.id
          WHERE pair.kind = 'GROUP_MEMBER'
            AND pair.active = true
            AND thread.type = 'GROUP'
            AND group_user.account = ${normalizeAccount(item.thread.account)}
            AND group_user.domain = 'local'
            AND group_user."namespaceId" = 0
            AND (
              (pair."endpointAType" = 'GROUP'
                AND pair."endpointAAccount" = group_user.account
                AND pair."endpointADomain" = 'local'
                AND pair."endpointANamespaceId" = ${namespaceId}
                AND pair."endpointBType" = 'USER'
                AND pair."endpointBAccount" = ${remoteMemberAccount}
                AND pair."endpointBDomain" = ${sourceDomain}
                AND pair."endpointBNamespaceId" = ${namespaceId})
              OR
              (pair."endpointBType" = 'GROUP'
                AND pair."endpointBAccount" = group_user.account
                AND pair."endpointBDomain" = 'local'
                AND pair."endpointBNamespaceId" = ${namespaceId}
                AND pair."endpointAType" = 'USER'
                AND pair."endpointAAccount" = ${remoteMemberAccount}
                AND pair."endpointADomain" = ${sourceDomain}
                AND pair."endpointANamespaceId" = ${namespaceId})
            )
          LIMIT 1
          FOR SHARE OF pair, thread
        `);
        threadRows = memberResult.rows;
      }
    } else {
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
        FROM "RelationshipPair" pair
        JOIN "MessageThread" thread ON thread.id = pair."threadId"
        JOIN "AccountThreadState" local_participant
          ON local_participant."threadId" = thread.id
        JOIN "Account" local_user ON local_user.id = local_participant."accountId"
        WHERE thread.type = 'P2P'
          AND pair.kind = 'P2P'
          AND pair.active = true
          AND local_user.domain = 'local'
          AND local_user."namespaceId" = 0
          AND local_user.account = ${normalizeAccount(item.thread.peerAccount)}
          AND (
            (pair."endpointAType" = 'USER'
              AND pair."endpointAAccount" = local_user.account
              AND pair."endpointADomain" = 'local'
              AND pair."endpointANamespaceId" = ${namespaceId}
              AND pair."endpointBType" = 'USER'
              AND pair."endpointBAccount" = ${normalizeAccount(item.thread.account)}
              AND pair."endpointBDomain" = ${sourceDomain}
              AND pair."endpointBNamespaceId" = ${namespaceId})
            OR
            (pair."endpointBType" = 'USER'
              AND pair."endpointBAccount" = local_user.account
              AND pair."endpointBDomain" = 'local'
              AND pair."endpointBNamespaceId" = ${namespaceId}
              AND pair."endpointAType" = 'USER'
              AND pair."endpointAAccount" = ${normalizeAccount(item.thread.account)}
              AND pair."endpointADomain" = ${sourceDomain}
              AND pair."endpointANamespaceId" = ${namespaceId})
          )
        LIMIT 1
        FOR SHARE OF pair, thread, local_participant
      `);
      threadRows = result.rows;
    }
    const route = threadRows[0];
    if (!route) {
      throw new FederationMessageContextError(
        'missed message has no retained local thread',
      );
    }
    const creatorAccount = normalizeAccount(author.account);
    const creatorDomain =
      author.domain === this.config.domain ? 'local' : author.domain;
    const recipientRows =
      'peerAccount' in item.thread
        ? await tx.execute<{ userId: number }>(sql`
            SELECT participant."accountId" AS "userId"
            FROM "AccountThreadState" participant
            WHERE participant."threadId" = ${route.threadId}
            FOR SHARE OF participant
          `)
        : await tx.execute<{ userId: number }>(sql`
            SELECT participant."accountId" AS "userId"
            FROM "AccountThreadState" participant
            WHERE participant."threadId" = ${route.threadId}
            FOR SHARE OF participant
          `);
    const recipients = recipientRows.rows.map((row) => row.userId);
    if (!('peerAccount' in item.thread)) {
      const recipientAuthorization: boolean[] = [];
      for (const userId of recipients)
        recipientAuthorization.push(
          await isThreadMutuallyAuthorized(tx, userId, route.threadId),
        );
      return {
        ...route,
        creatorAccount,
        creatorDomain,
        recipients: recipients.filter(
          (_, index) => recipientAuthorization[index],
        ),
      };
    }
    return {
      ...route,
      creatorAccount,
      creatorDomain,
      recipients,
    };
  }

  async resolveTombstone(
    tx: DatabaseTransaction,
    thread: FederationThreadAddress,
    sourceDomain: string,
    namespaceId: number,
    messageSeq?: number,
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
      JOIN ${groupStateSql} group_user ON group_user.id = message_thread.id
      WHERE message_thread.type = 'GROUP'
        AND group_user.account = ${normalizeAccount(thread.account)}
        AND group_user.domain = ${sourceDomain}
        AND group_user."namespaceId" = ${namespaceId}
      LIMIT 1
      FOR SHARE OF message_thread
    `);
    const route = rows.rows[0];
    if (!route && messageSeq !== undefined) {
      // A member may retract only a retained message authored on its own server.
      // Reuse message routing to lock and validate that author's active membership.
      const targets = await tx.execute<{ account: string }>(sql`
        SELECT m."creatorAccount" AS account
        FROM "Message" m
        JOIN "MessageThread" t ON t.id = m."threadId"
        JOIN ${groupStateSql} g ON g.id = t.id
        WHERE g.account = ${normalizeAccount(thread.account)}
          AND g.domain = 'local' AND g."namespaceId" = 0
          AND m."sourceNamespaceId" = ${namespaceId}
          AND m."originSeq" = ${messageSeq}
          AND m."creatorDomain" = ${sourceDomain}
          AND m."contentType" <> 'SYSTEM'
        LIMIT 1
      `);
      const target = targets.rows[0];
      if (target) {
        const memberRoute = await this.resolveMessage(
          tx,
          {
            thread,
            author: { account: target.account, domain: sourceDomain },
          } as FederationMessageFeedMessage,
          sourceDomain,
          namespaceId,
        );
        return {
          ...memberRoute,
          groupOriginDomain: this.config.domain,
          memberSubmission: true,
        };
      }
    }
    if (!route) {
      throw new FederationMessageContextError(
        'tombstone has no retained local group thread',
      );
    }
    const recipientRows = await tx.execute<{ userId: number }>(sql`
      SELECT participant."accountId" AS "userId"
      FROM "AccountThreadState" participant
      WHERE participant."threadId" = ${route.threadId}
      FOR SHARE OF participant
    `);
    const recipientAuthorization: boolean[] = [];
    for (const row of recipientRows.rows) {
      recipientAuthorization.push(
        await isThreadMutuallyAuthorized(tx, row.userId, route.threadId),
      );
    }
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
