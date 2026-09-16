import { Injectable, Logger } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../../../database/database.service.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../../../user/account-address.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import { lockBusinessAccountsInTx } from '../../../common/business/locks/account-business-lock.js';
import { lockRelationshipPairsInTx } from '../../../common/business/locks/relationship-pair-business-lock.js';
import { completeBusinessAddress } from '../../../common/business/locks/business-address.js';
import { requireGroupThreadContentLockUnderGroupInTx } from '../../../common/business/locks/thread-content-lock.js';
import { groupStateSql } from '../shared/group-state.js';
import {
  mirrorGroupDisbandRevocationSql,
  type MirrorGroupDisbandRevocationInput,
} from './mirror-group-disband-revocation-sql.js';

export interface MirrorGroupDisbandTombstoneCommand {
  threadId: number;
  groupAccount: string;
  peerDomain: string;
  namespaceId: number;
  expectedAuthorizationEpoch: number;
}

export interface MirrorGroupDisbandMemberCommand {
  threadId: number;
  memberUserId: AccountTarget;
  expectedAuthorizationEpoch: number;
}

interface MirrorDisbandLocator {
  groupAccount: string;
  groupDomain: string;
  namespaceId: number;
  dissolvedAt: string | null;
  authorizationEpoch: number;
  pairId: string | null;
  localMemberId: number | null;
}

/** Local convergence for a mirrored group whose origin denied us: a recoverable
 * dissolution tombstone and, per still-active local membership, the departure boundary.
 * The caller is the system; the origin's denial is the authority, so there is
 * no manager or role gate. Lock order follows the mirror applier: the group
 * ACCOUNT scope at the authority domain, the Pair scope, then Thread Content. */
@Injectable()
export class MirrorGroupDisbandService {
  private readonly logger = new Logger(MirrorGroupDisbandService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly clientFeed: ClientStateFeedService,
  ) {}

  /** The recoverable dissolution tombstone for a mirror: `MessageThread.groupDissolvedAt`
   * (the mirror arm of the unified `groupState.dissolvedAt`), with federation
   * rounds fenced off until a later positive activation reopens the thread.
   * The authorization epoch advances with the transition, matching the denial
   * path's fencing; replays observe the dissolved state and return unchanged. */
  async markDissolved(
    params: MirrorGroupDisbandTombstoneCommand,
  ): Promise<{ transitioned: boolean }> {
    return this.database.db.transaction(async (tx) => {
      await lockBusinessAccountsInTx(tx, [
        { account: params.groupAccount, domain: params.peerDomain },
      ]);
      const located = await this.locateInTx(tx, params.threadId, null);
      if (
        !located ||
        located.groupAccount !== params.groupAccount ||
        located.groupDomain !== params.peerDomain ||
        located.namespaceId !== params.namespaceId
      )
        throw new Error('mirror disband group identity changed');
      if (
        located.authorizationEpoch !== params.expectedAuthorizationEpoch ||
        located.dissolvedAt !== null
      )
        return { transitioned: false };
      await requireGroupThreadContentLockUnderGroupInTx(
        tx,
        params.threadId,
        params.threadId,
      );
      const dissolved = await tx.execute<{ id: number }>(sql`
        UPDATE "MessageThread"
        SET "groupDissolvedAt" = CURRENT_TIMESTAMP,
          "federationRoundsEnabled" = false,
          "authorizationEpoch" = "authorizationEpoch" + 1,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE id = ${params.threadId} AND "groupDissolvedAt" IS NULL
        RETURNING id
      `);
      if (dissolved.rows.length > 0) {
        // The sweep is about to tear down the whole local roster, so the
        // mirror's applied roster is stale by definition. A zero processed
        // cursor with a closed window re-selects a full snapshot if a later
        // activation reopens it.
        await tx.execute(sql`
          UPDATE "GroupMeta"
          SET "metaTargetId" = 0, "metaProcessedThroughId" = 0,
            "metaRecoveryThroughId" = NULL, "updatedAt" = CURRENT_TIMESTAMP
          WHERE "threadId" = ${params.threadId}
        `);
      }
      return { transitioned: dissolved.rows.length > 0 };
    });
  }

  /** One sweep step: depart one local member of an already-dissolved mirror. */
  async revokeMember(
    params: MirrorGroupDisbandMemberCommand,
  ): Promise<{ transitioned: boolean }> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const transitioned = await this.database.db.transaction(async (tx) => {
      const member = await accountAddressInTx(tx, params.memberUserId);
      const located = await this.locateInTx(
        tx,
        params.threadId,
        member.account,
      );
      if (!located) throw new Error('mirror disband group is missing');
      if (!located.pairId) return false;
      await lockBusinessAccountsInTx(tx, [
        { account: located.groupAccount, domain: located.groupDomain },
      ]);
      await lockRelationshipPairsInTx(tx, [
        {
          kind: 'GROUP_MEMBER',
          addresses: [
            completeBusinessAddress(located.groupAccount, located.groupDomain),
            completeBusinessAddress(member.account, member.domain),
          ],
        },
      ]);
      await requireGroupThreadContentLockUnderGroupInTx(
        tx,
        params.threadId,
        params.threadId,
      );
      // The locator above only names advisory scopes; the dissolved gate and
      // pair coordinates are re-read after the locks they name.
      const current = await this.locateInTx(
        tx,
        params.threadId,
        member.account,
      );
      if (
        !current ||
        current.groupAccount !== located.groupAccount ||
        current.groupDomain !== located.groupDomain
      )
        throw new Error('mirror group identity changed while locking');
      if (
        current.dissolvedAt === null ||
        current.authorizationEpoch !== params.expectedAuthorizationEpoch
      )
        return false;
      if (!current.pairId || current.localMemberId === null) return false;
      const pairId = BigInt(current.pairId);
      const [lockedPair] = (
        await tx.execute<{ id: string }>(sql`
          SELECT id::text FROM "RelationshipPair"
          WHERE id = ${pairId} AND "threadId" = ${params.threadId}
          FOR NO KEY UPDATE
        `)
      ).rows;
      if (!lockedPair) return false;
      await tx.execute(
        sql`SELECT id FROM "RelationshipIntent" WHERE "pairId" = ${pairId}
          ORDER BY "authorSide" FOR NO KEY UPDATE`,
      );
      await tx.execute(
        sql`SELECT participant.id FROM "AccountThreadState" participant
          WHERE participant."threadId" = ${params.threadId}
            AND participant."accountId" = ${current.localMemberId}
          ORDER BY participant."accountId" FOR NO KEY UPDATE OF participant`,
      );
      const presentation = (
        await tx.execute<{
          account: string;
          domain: string;
          namespaceId: number;
          name: string;
          avatar: string;
          description: string;
          profileRev: number;
        }>(sql`
          SELECT "account", "domain", "namespaceId",
            "name", "avatar", "description", "profileRev"
          FROM ${groupStateSql} g WHERE g.id = ${params.threadId}
        `)
      ).rows[0];
      if (!presentation) throw new Error('mirror disband group is missing');
      const input: MirrorGroupDisbandRevocationInput = {
        threadId: params.threadId,
        pairId,
        presentation: {
          groupAccount: presentation.account,
          groupDomain: presentation.domain,
          groupNamespaceId: presentation.namespaceId,
          groupName: presentation.name,
          groupAvatar: presentation.avatar,
          groupDescription: presentation.description,
          groupProfileRev: presentation.profileRev,
        },
        memberAccount: member.account,
        localMemberId: current.localMemberId,
      };
      const row = (
        await tx.execute<{
          intentChanged: boolean;
          pairChanged: boolean;
          departureInserted: boolean;
          recipientUserId: number | null;
          recipientFeedId: string | null;
        }>(mirrorGroupDisbandRevocationSql(input))
      ).rows[0];
      if (!row) throw new Error('mirror disband revocation update disappeared');
      if (row.recipientUserId !== null && row.recipientFeedId !== null)
        clientUpdates.push({
          userId: row.recipientUserId,
          feedId: Number(row.recipientFeedId),
        });
      return row.pairChanged || row.intentChanged;
    });
    if (clientUpdates.length > 0) {
      try {
        this.clientFeed.notifyFeedUpdates(clientUpdates);
      } catch (error) {
        this.logger.warn(
          'mirror disband revocation client-state wake failed',
          error,
        );
      }
    }
    return { transitioned };
  }

  /** Use before locking only to name the business scopes and fail fast on a
   * missing group or pair. It authorizes nothing; the dissolved gate and every
   * mutable state are re-read after the locks. `memberAccount` is null for the
   * tombstone command, which needs no pair. */
  private async locateInTx(
    tx: DatabaseTransaction,
    threadId: number,
    memberAccount: string | null,
  ): Promise<MirrorDisbandLocator | null> {
    const located = (
      await tx.execute<{
        groupAccount: string;
        groupDomain: string;
        namespaceId: number;
        dissolvedAt: string | null;
        authorizationEpoch: number;
        pairId: string | null;
        localMemberId: number | null;
      }>(sql`
        SELECT g.account AS "groupAccount", g.domain AS "groupDomain",
          g."namespaceId" AS "namespaceId",
          g."dissolvedAt" AS "dissolvedAt",
          thread."authorizationEpoch" AS "authorizationEpoch",
          ${
            memberAccount === null
              ? sql`NULL::text AS "pairId", NULL::integer AS "localMemberId"`
              : sql`(
            SELECT pair.id::text FROM "RelationshipPair" pair
            WHERE pair.kind = 'GROUP_MEMBER' AND pair."threadId" = ${threadId}
              AND pair."endpointBType" = 'USER'
              AND pair."endpointBAccount" = ${memberAccount}
              AND pair."endpointBDomain" = 'local'
            LIMIT 1
          ) AS "pairId",
          (SELECT a.id FROM "Account" a WHERE a.account = ${memberAccount}
            AND a.domain = 'local' AND a."namespaceId" = 0 LIMIT 1)
            AS "localMemberId"`
          }
        FROM ${groupStateSql} g
        JOIN "MessageThread" thread ON thread.id = g.id
        WHERE g.id = ${threadId}
        LIMIT 1
      `)
    ).rows[0];
    if (!located) return null;
    return {
      groupAccount: located.groupAccount,
      groupDomain: located.groupDomain,
      namespaceId: located.namespaceId,
      dissolvedAt: located.dissolvedAt,
      authorizationEpoch: located.authorizationEpoch,
      pairId: located.pairId,
      localMemberId: located.localMemberId,
    };
  }
}
