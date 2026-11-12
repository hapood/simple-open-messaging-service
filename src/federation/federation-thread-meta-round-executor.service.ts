import {
  groupStateFields,
  groupStateSql,
} from '../group/shared/group-state.js';
import {
  applyDeltaMirrorMetaItemInTx,
  finalizeDeltaMirrorMetaRoundInTx,
} from '../group/meta/apply-delta-mirror-meta-item-in-tx.js';
import { applyFullMirrorMetaBatchInTx } from '../group/meta/apply-full-mirror-meta-batch-in-tx.js';
import {
  reopenMirrorMetaRecoveryInTx,
  type MirrorGroupAddress,
  type MirrorMetaReplicatedItem,
} from '../group/meta/mirror-meta-shared.js';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { MessageService } from '../message/message.service.js';
import { MESSAGE_PROFILE_WORK_COMMITTED } from '../message/message-profile-work.event.js';
import {
  isValidGroupAccount,
  isValidSomfpUserAccount,
  normalizeAccount,
} from '../common/account.js';
import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { GroupRole } from '../database/enums.js';
import { RemoteGroupMetaCursorUnavailableError } from './federation-feed-cursor-error.js';
import { FederationGroupMetaClient } from './federation-group-meta-client.service.js';
import { ProfileResolutionCoordinatorService } from '../profile-resolution/profile-resolution-coordinator.service.js';
import type { GroupMetaFeedItem } from './group-meta-feed.service.js';

/** Page budget for one scheduler invocation; the scheduler requeues while the
 * applied cursor still trails the target. */
const META_ROUND_PAGE_BUDGET = 4;
/** Hard ceiling for one full snapshot scan; a legitimate roster never nears it. */
const MAX_FULL_SNAPSHOT_PAGES = 200;

export interface MetaRoundPlan {
  groupAccount: string;
  metaTargetId: number;
  metaProcessedThroughId: number;
  /** The open recovery drain's fixed through; null selects delta. */
  metaRecoveryThroughId: number | null;
}

/** One bounded Group Meta round for a mirrored group, driven by the federation
 * thread round scheduler. The start cursor and target live on GroupMeta
 * (`metaProcessedThroughId` / `metaTargetId`); an open `metaRecoveryThroughId`
 * recovery drain consumes full-snapshot page batches, and delta rounds consume one
 * feed item per transaction. Every state mutation runs through
 * `group/meta` — this executor owns the S2S pull, wire validation,
 * and the round budget only. */
@Injectable()
export class FederationThreadMetaRoundExecutorService {
  constructor(
    private readonly database: DatabaseService,
    private readonly client: FederationGroupMetaClient,
    private readonly messages: MessageService,
    private readonly profileResolutions: ProfileResolutionCoordinatorService,
    private readonly events: EventEmitter2,
  ) {}

  /** Returns true when another round is needed: the page budget ran out
   * mid-pull, or the applied cursor still trails the target after completing. */
  async run(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<boolean> {
    const plan = await this.plan(threadId, peerDomain, namespaceId);
    if (!plan) return false;
    if (plan.metaTargetId <= plan.metaProcessedThroughId) return false;
    const windowed = plan.metaRecoveryThroughId !== null;
    const through = plan.metaRecoveryThroughId ?? plan.metaTargetId;
    const group: MirrorGroupAddress = {
      account: plan.groupAccount,
      domain: peerDomain,
      publisherNamespaceId: namespaceId,
    };
    try {
      if (windowed) await this.runFullWindow(group, through, plan);
      else if (await this.runDeltaPages(group, plan)) return true;
    } catch (error) {
      if (error instanceof RemoteGroupMetaCursorUnavailableError) {
        // Compaction can invalidate either a delta cursor or a fixed full
        // boundary. Re-open at the source's current end before any commit.
        await this.database.db.transaction(async (tx) =>
          reopenMirrorMetaRecoveryInTx(tx, group, error.resumeBefore - 1),
        );
        return true;
      }
      throw error;
    }
    const next = await this.plan(threadId, peerDomain, namespaceId);
    return next !== null && next.metaTargetId > next.metaProcessedThroughId;
  }

  private async plan(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<MetaRoundPlan | null> {
    const result = await this.database.db.execute<{
      groupAccount: string;
      metaEndId: number | null;
      metaTargetId: number | null;
      metaProcessedThroughId: number | null;
      metaRecoveryThroughId: number | null;
    }>(sql`
      SELECT ${groupStateFields.account} AS "groupAccount",
        feed."metaEndId" AS "metaEndId",
        feed."metaTargetId" AS "metaTargetId",
        feed."metaProcessedThroughId" AS "metaProcessedThroughId",
        feed."metaRecoveryThroughId" AS "metaRecoveryThroughId"
      FROM "MessageThread" thread
      JOIN ${groupStateSql} group_state ON group_state.id = thread.id
      LEFT JOIN "GroupMeta" feed ON feed."threadId" = thread.id
      WHERE thread.id = ${threadId}
        AND thread."federationRoundsEnabled" = true
        AND ${groupStateFields.namespaceId} = ${namespaceId}
      LIMIT 1
    `);
    const row = result.rows[0];
    if (!row || row.metaEndId === null) return null;
    return {
      groupAccount: row.groupAccount,
      metaTargetId: row.metaTargetId!,
      metaProcessedThroughId: row.metaProcessedThroughId!,
      metaRecoveryThroughId: row.metaRecoveryThroughId,
    };
  }

  /** Delta rounds consume one feed item per transaction; the round's last
   * item finalizes inside its own transaction. */
  private async runDeltaPages(
    group: MirrorGroupAddress,
    plan: MetaRoundPlan,
  ): Promise<boolean> {
    let after = plan.metaProcessedThroughId;
    for (let page = 0; page < META_ROUND_PAGE_BUDGET; page += 1) {
      const fetched = await this.client.fetchPage(group.domain, {
        account: group.account,
        mode: 'delta',
        after,
        through: plan.metaTargetId,
      });
      if (fetched.groupMetaFeedEndId < plan.metaTargetId)
        throw new Error('group-meta page did not reach its fixed target');
      const items = fetched.items.map((item) =>
        validateOriginGroupMetaItem(item, 'delta'),
      );
      const reachedBoundary = !fetched.hasMore;
      if (items.length === 0 && reachedBoundary) {
        await this.database.db.transaction(async (tx) =>
          finalizeDeltaMirrorMetaRoundInTx(tx, {
            group,
            through: plan.metaTargetId,
          }),
        );

        return false;
      }
      for (const [index, item] of items.entries()) {
        const effect = await this.database.db.transaction(async (tx) =>
          applyDeltaMirrorMetaItemInTx(tx, {
            group,
            item,
            through: plan.metaTargetId,
            reachedBoundary: reachedBoundary && index === items.length - 1,
            messages: this.messages,
          }),
        );
        await this.prefetchProfiles(
          effect.profileDemand ? [effect.profileDemand] : [],
        );
        if (effect.systemMessageProfileWork)
          this.events.emit(
            MESSAGE_PROFILE_WORK_COMMITTED,
            effect.systemMessageProfileWork,
          );
      }
      after = fetched.scannedThrough;
      if (!fetched.hasMore) return false;
    }
    return true;
  }

  /** Recovery drains consume one fetched page batch per transaction,
   * resuming from the durable scan cursor after a crash. */
  private async runFullWindow(
    group: MirrorGroupAddress,
    through: number,
    _plan: MetaRoundPlan,
  ): Promise<void> {
    let after = 0;
    const snapshot: MirrorMetaReplicatedItem[] = [];
    for (let pages = 0; ; pages += 1) {
      const page = await this.client.fetchPage(group.domain, {
        account: group.account,
        mode: 'full',
        after,
        through,
      });
      const items = page.items.map((item) =>
        validateOriginGroupMetaItem(item, 'full'),
      );
      const reachedBoundary = !page.hasMore;
      snapshot.push(...items);
      if (reachedBoundary) {
        const effect = await this.database.db.transaction(async (tx) =>
          applyFullMirrorMetaBatchInTx(tx, {
            group,
            items: snapshot,
            through,
            scannedThrough: page.scannedThrough,
            reachedBoundary: true,
          }),
        );
        await this.prefetchProfiles(effect.profileDemands);

        return;
      }
      if (pages >= MAX_FULL_SNAPSHOT_PAGES)
        throw new Error('full group-meta snapshot exceeded the page ceiling');
      after = page.scannedThrough;
    }
  }

  private async prefetchProfiles(
    demands: readonly import('../profile-resolution/profile-resolution-demand.js').ProfilePrefetchDemand[],
  ): Promise<void> {
    for (const demand of demands) {
      try {
        await this.profileResolutions.resolveDemand(demand);
      } catch {
        // Meta is already committed. Snapshot prefetch is opportunistic and
        // may be retried by a later Meta reference or client demand.
      }
    }
  }
}

/** The origin refused an authorized read — 'group meta is not visible to this
 * peer'. There is no authorized state behind a denial, so this is terminal. */

export function validateOriginGroupMetaItem(
  item: GroupMetaFeedItem,
  mode: 'full' | 'delta',
): MirrorMetaReplicatedItem {
  const feedId = item.feedId;
  requireKeys(item, ['feedId', 'originCreatedAt', 'operation', 'body']);
  const originCreatedAt = item.originCreatedAt;
  if (
    !Number.isSafeInteger(originCreatedAt) ||
    originCreatedAt < 0 ||
    !Number.isFinite(new Date(originCreatedAt).getTime())
  )
    throw new Error('invalid group-meta origin creation time');
  if (item.operation === 'GROUP_ANNOUNCEMENT') {
    requireKeys(item.body, ['text']);
    const text = item.body.text;
    if (
      text !== null &&
      (typeof text !== 'string' ||
        [...text].length < 1 ||
        [...text].length > 4096)
    )
      throw new Error('invalid group-meta announcement item');
    return {
      feedId,
      originCreatedAt,
      operation: 'GROUP_ANNOUNCEMENT',
      text,
    };
  }
  if (item.operation === 'GROUP_PROFILE') {
    requireKeys(item.body, ['account', 'namespaceId', 'profileRev']);
    if (
      !isValidGroupAccount(item.body.account) ||
      !isProfileRev(item.body.profileRev) ||
      !isProfileNamespaceId(item.body.namespaceId)
    )
      throw new Error('invalid group-meta profile item');
    return {
      feedId,
      originCreatedAt,
      operation: 'GROUP_PROFILE',
      account: item.body.account,
      namespaceId: item.body.namespaceId,
      profileRev: item.body.profileRev,
    };
  }
  if (
    !isValidSomfpUserAccount(item.body.account) ||
    item.body.account !== normalizeAccount(item.body.account)
  )
    throw new Error('invalid group-meta member address');
  if (item.operation === 'MEMBER_DEPART') {
    if (mode === 'full')
      throw new Error('full group-meta cannot contain MEMBER_DEPART');
    requireKeys(item.body, ['account', 'namespaceId', 'role', 'profileRev']);
    if (
      !Object.values(GroupRole).includes(item.body.role as GroupRole) ||
      !isProfileRev(item.body.profileRev) ||
      !isProfileNamespaceId(item.body.namespaceId)
    )
      throw new Error('invalid group-meta member body');
    return {
      feedId,
      originCreatedAt,
      operation: 'MEMBER_DEPART',
      account: item.body.account,
      namespaceId: item.body.namespaceId,
      role: item.body.role as GroupRole,
      profileRev: item.body.profileRev,
    };
  }
  if (item.operation !== 'MEMBER_UPSERT')
    throw new Error('invalid group-meta operation');
  requireKeys(item.body, ['account', 'namespaceId', 'role', 'profileRev']);
  if (
    !Object.values(GroupRole).includes(item.body.role as GroupRole) ||
    !isProfileRev(item.body.profileRev) ||
    !isProfileNamespaceId(item.body.namespaceId)
  )
    throw new Error('invalid group-meta member body');
  return {
    feedId,
    originCreatedAt,
    operation: 'MEMBER_UPSERT',
    account: item.body.account,
    namespaceId: item.body.namespaceId,
    role: item.body.role as GroupRole,
    profileRev: item.body.profileRev,
  };
}

function requireKeys(value: object, expected: readonly string[]): void {
  const keys = Object.keys(value).sort();
  const required = [...expected].sort();
  if (
    keys.length !== required.length ||
    keys.some((key, index) => key !== required[index])
  )
    throw new Error('invalid group-meta item shape');
}

function isProfileRev(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isProfileNamespaceId(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
