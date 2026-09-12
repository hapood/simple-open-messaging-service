import { Injectable, Logger } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { relationshipPair } from '../../../database/schema.js';
import { BusinessCode } from '../../../common/business-code.js';
import { BusinessException } from '../../../common/business.exception.js';
import type {
  DatabaseService,
  DatabaseTransaction,
} from '../../../database/database.service.js';
import type { NamespacedAddress } from '../../../common/client-identity.js';
import {
  accountAddressInTx,
  type AccountTarget,
} from '../../../user/account-address.js';
import { lockBusinessAccountsInTx } from '../../shared/locks/account-business-lock.js';
import { lockRelationshipPairsInTx } from '../../shared/locks/relationship-pair-business-lock.js';
import { completeBusinessAddress } from '../../shared/locks/business-address.js';
import {
  requireGroupThreadContentLockUnderGroupInTx,
  type ThreadContentLock,
} from '../../shared/locks/thread-content-lock.js';
import { captureThreadStateUpdatesInTx } from '../../../client-state-feed/capture-thread-state-updates.js';
import type {
  ClientStateFeedService,
  PendingClientStateFeedUpdate,
} from '../../../client-state-feed/client-state-feed.service.js';
import type { FederationService } from '../../../federation/federation.service.js';
import type { PeerStateFeedService } from '../../../federation/peer-state-feed.service.js';
import {
  groupMembershipStateSql,
  type GroupMembershipStateRow,
} from '../shared/group-membership-state-sql.js';
import {
  groupDisbandMembershipRevocationLocatorSql,
  groupDisbandMembershipRevocationSql,
  type GroupDisbandMembershipRevocationInput,
} from './group-disband-membership-revocation-sql.js';

/** One command: the disband sweep's per-member departure. The DISBAND_GROUP
 * task commits the terminal group fact and its cursor fans out one
 * FORCE_REVOKE_GROUP_MEMBER child per still-active membership pair; this
 * service is what a child executes. The member arrives as the sweep's task
 * payload — a local Account.id or a wire-level address; the caller is the
 * system, the dissolved group itself is the authority, so there is no manager
 * or role gate. */
export interface GroupDisbandMembershipRevocationCommand {
  threadId: number;
  memberAddress: AccountTarget;
}

export interface GroupDisbandMembershipRevocationDependencies {
  database: DatabaseService;
  clientFeed: ClientStateFeedService;
  peerFeed: PeerStateFeedService;
  federation: FederationService;
}

/** Lexical capability, created only after locks and authorization. */
interface ValidatedRevocation {
  readonly tx: DatabaseTransaction;
  readonly threadLock: ThreadContentLock;
  readonly pairId: bigint;
  readonly localMemberId: number | null;
  readonly peerDomain: string | null;
  readonly input: GroupDisbandMembershipRevocationInput;
}

@Injectable()
export class GroupDisbandMembershipRevocationService {
  private readonly logger = new Logger(
    GroupDisbandMembershipRevocationService.name,
  );

  constructor(
    private readonly deps: GroupDisbandMembershipRevocationDependencies,
  ) {}

  async execute(
    params: GroupDisbandMembershipRevocationCommand,
  ): Promise<{ transitioned: boolean }> {
    const clientUpdates: PendingClientStateFeedUpdate[] = [];
    const peers = await this.deps.database.db.transaction(async (tx) => {
      const context = await this.lockAndValidateInTx(tx, params);
      if (!context) return undefined;
      return this.applyInTx(context, clientUpdates);
    });
    if (!peers) return { transitioned: false };
    try {
      if (clientUpdates.length > 0)
        this.deps.clientFeed.notifyFeedUpdates(clientUpdates);
    } catch (error) {
      this.logger.warn('dissolve revocation client-state wake failed', error);
    }
    if (peers.size === 0) return { transitioned: true };
    void this.deps.federation
      .pushStateFeedDomains(peers.keys())
      .catch((error: unknown) =>
        this.logger.warn('dissolve revocation state-feed wake failed', error),
      );
    return { transitioned: true };
  }

  private async lockAndValidateInTx(
    tx: DatabaseTransaction,
    params: GroupDisbandMembershipRevocationCommand,
  ): Promise<ValidatedRevocation | undefined> {
    // The sweep's payload names the member as a local Account.id or an
    // address; every downstream statement uses the canonical address form.
    const member: NamespacedAddress = await accountAddressInTx(
      tx,
      params.memberAddress,
    );
    // One pre-lock locator: the group's address and, when it exists, the
    // member's pair name the business scopes. It authorizes nothing; every
    // mutable state is re-read after the locks it names. The gates keep the
    // legacy order — group, dissolution, then the member.
    const located = (
      await tx.execute<{
        groupAccount: string;
        groupDomain: string;
        dissolvedAt: string | null;
        pairId: string | null;
        localMemberId: number | null;
      }>(
        groupDisbandMembershipRevocationLocatorSql({
          threadId: params.threadId,
          member,
        }),
      )
    ).rows[0];
    if (!located)
      throw new BusinessException(BusinessCode.NOT_FOUND, 'group not found');
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
    const threadLock = await requireGroupThreadContentLockUnderGroupInTx(
      tx,
      params.threadId,
      params.threadId,
    );
    // The locator above only names advisory scopes. Re-read the dissolution and
    // pair coordinates after both business locks and the group thread row lock.
    const current = (
      await tx.execute<{
        groupAccount: string;
        groupDomain: string;
        dissolvedAt: string | null;
        pairId: string | null;
        localMemberId: number | null;
      }>(
        groupDisbandMembershipRevocationLocatorSql({
          threadId: params.threadId,
          member,
        }),
      )
    ).rows[0];
    if (
      !current ||
      current.groupAccount !== located.groupAccount ||
      current.groupDomain !== located.groupDomain
    )
      throw new Error('group identity changed while acquiring business locks');
    if (!current.dissolvedAt)
      throw new Error('group member fan-out requires a dissolved group');
    if (!current.pairId) {
      // The legacy sweep's lock chain mints the canonical pair when the
      // address never joined, then departs it; reproduce that contract so a
      // replayed child never fails for lack of a pair.
      const relationshipNamespaceId = member.namespaceId;
      const minted = await tx.execute<{ id: string }>(sql`
        INSERT INTO "RelationshipPair"
          (kind, "endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
           "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId", "threadId")
        VALUES ('GROUP_MEMBER', 'GROUP', ${located.groupAccount}, ${located.groupDomain},
          ${relationshipNamespaceId}, 'USER', ${member.account}, ${member.domain},
          ${relationshipNamespaceId}, ${params.threadId})
        ON CONFLICT ("endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
          "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId")
        DO UPDATE SET "threadId" = EXCLUDED."threadId", "updatedAt" = CURRENT_TIMESTAMP
        RETURNING id
      `);
      current.pairId = minted.rows[0]!.id;
    }
    const pairId = BigInt(current.pairId);
    const [lockedPair] = await tx
      .select()
      .from(relationshipPair)
      .where(eq(relationshipPair.id, pairId))
      .for('no key update');
    if (!lockedPair) throw new Error('disband revocation pair not found');
    if (lockedPair.threadId !== params.threadId)
      throw new Error('disband revocation pair changed');
    const pairWasActive = lockedPair.active;
    await tx.execute(
      sql`SELECT id FROM "RelationshipIntent" WHERE "pairId" = ${pairId} ORDER BY "authorSide" FOR NO KEY UPDATE`,
    );
    // The member's own AccountThreadState row is the one participant row the
    // composed statement writes (the departure watermark).
    if (current.localMemberId !== null)
      await tx.execute(
        sql`SELECT participant.id FROM "AccountThreadState" participant
          WHERE participant."threadId" = ${params.threadId}
            AND participant."accountId" = ${current.localMemberId}
          ORDER BY participant."accountId" FOR NO KEY UPDATE OF participant
        `,
      );
    // The membership authorization binds `authorized` to a calling member
    // account; a system caller has none, so the bind is a constant and the
    // column goes unconsumed. Everything else the composed statement needs —
    // the group profile snapshot, both intent states, the manager set, and the
    // member's live projection directions — is the same post-lock read the
    // member-side commands take.
    const row = (
      await tx.execute<GroupMembershipStateRow>(
        groupMembershipStateSql({
          threadId: params.threadId,
          pairId,
          actorUserId: null,
          memberAccount: member.account,
          memberDomain: member.domain,
          memberNamespaceId: member.namespaceId,
        }),
      )
    ).rows[0];
    if (!row || row.domain !== 'local' || row.namespaceId !== 0)
      throw new Error('disband revocation requires an authoritative group');
    // Legacy transition gate: the side B intent being REVOKED already is the
    // idempotent no-op; a missing intent row still departs.
    if (row.memberIntentStatus === 'REVOKED') return undefined;
    if (row.memberDomain !== 'local')
      await this.deps.peerFeed.lockOutboundStateFeedNamespacesInTx(tx, [
        {
          peerDomain: row.memberDomain,
          namespaceId: row.memberNamespaceId,
        },
      ]);
    const accounts = [
      ...row.managerIds,
      ...(row.localMemberId === null ? [] : [row.localMemberId]),
    ];
    if (accounts.length > 0)
      await tx.execute(
        sql`SELECT id FROM "Account" WHERE id = ANY(${sql.param(accounts)}::integer[]) ORDER BY id FOR NO KEY UPDATE`,
      );
    return {
      tx,
      threadLock,
      pairId,
      localMemberId: row.localMemberId,
      peerDomain: row.memberDomain === 'local' ? null : row.memberDomain,
      input: {
        threadId: params.threadId,
        pairId,
        groupAccount: row.account,
        groupName: row.name,
        groupAvatar: row.avatar,
        groupDescription: row.description,
        groupProfileRev: row.profileRev,
        localDomain: row.domain,
        memberAccount: member.account,
        memberDomain: row.memberDomain,
        memberNamespaceId: row.memberNamespaceId,
        localMemberId: row.localMemberId,
        managerIds: row.managerIds,
        projectionDirections: row.projectionDirections,
        pairWasActive,
      },
    };
  }

  private async applyInTx(
    context: ValidatedRevocation,
    clientUpdates: PendingClientStateFeedUpdate[],
  ): Promise<Set<string>> {
    const result = await context.tx.execute<{
      intentChanged: boolean;
      pairChanged: boolean;
      audienceChanged: boolean;
      departureInserted: boolean;
      systemMessageSeq: number | null;
      recipientUserId: number | null;
      recipientFeedId: string | null;
    }>(groupDisbandMembershipRevocationSql(context.input));
    const row = result.rows[0];
    if (!row) throw new Error('disband revocation update disappeared');
    if (row.recipientUserId !== null && row.recipientFeedId !== null)
      clientUpdates.push({
        userId: row.recipientUserId,
        feedId: Number(row.recipientFeedId),
      });
    if (row.pairChanged && context.localMemberId !== null)
      clientUpdates.push(
        ...(await captureThreadStateUpdatesInTx(context.tx, [
          context.localMemberId,
        ])),
      );
    const peers = new Set<string>();
    if (context.peerDomain !== null) peers.add(context.peerDomain);
    return peers;
  }
}
