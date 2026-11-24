import { QuotaService } from '../quota/quota.service.js';
import { QuotaPausedError } from '../quota/quota-runtime.js';
import {
  FEDERATION_STATE_FEED_PUSH,
  type FederationStateFeedPush,
} from './federation-state-feed.events.js';
import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, eq, gt, or, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { DatabaseService } from '../database/database.service.js';
import {
  federationThreadSyncState,
  identityNamespace,
  messageThread,
} from '../database/schema.js';
import {
  FederationCooldownError,
  FederationMessageContextError,
  FederationThreadSourceInactiveError,
  S2sResponseError,
} from './federation-errors.js';
import { FederationThreadForwardRoundExecutorService } from './federation-thread-forward-round-executor.service.js';
import { FederationThreadMetaRoundExecutorService } from './federation-thread-meta-round-executor.service.js';
import {
  FEDERATION_THREAD_ROUND_WAKE,
  type FederationThreadRoundWake,
} from './federation-thread-round.events.js';
import { FederationThreadReverseRoundExecutorService } from './federation-thread-reverse-round-executor.service.js';
import { FEDERATION_THREAD_ROUND_DEFAULT_TAKE } from './federation-thread-round.constants.js';
import {
  FederationThreadRoundAuthorizationEpochChangedError,
  FederationThreadRoundDirectionError,
  FederationThreadRoundRemoteError,
} from './federation-thread-round-error.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';
import { FederationStatePullService } from './federation-state-pull.service.js';
import { FederationThreadQueryDenialService } from './federation-thread-query-denial.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';
import { KeypairService } from './keypair.service.js';
import {
  FederationThreadTaskQueue,
  type FederationThreadDirection as Direction,
  type FederationThreadTask,
} from './federation-thread-task-queue.js';
import { FederationPeerRuntimeService } from './federation-peer-runtime.service.js';
import {
  FEDERATION_NAMESPACE_PAUSED,
  FEDERATION_NAMESPACE_RESUMED,
  type FederationNamespaceSchedulingEvent,
} from './federation-peer.events.js';

const DEFAULT_MESSAGE_LIMIT = 4;
const DEFAULT_TOMBSTONE_LIMIT = 4;
const DEFAULT_REVERSE_LIMIT = 2;
const DEFAULT_META_LIMIT = 2;
/** Process-local scheduler for bounded per-thread synchronization rounds. */
@Injectable()
export class FederationThreadRoundSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(
    FederationThreadRoundSchedulerService.name,
  );
  private readonly tasks: FederationThreadTaskQueue;
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly stateDrains = new Map<
    number,
    {
      target: bigint;
      controller: AbortController;
      completion: Promise<void>;
    }
  >();
  private shuttingDown = false;
  async requestSourceRefresh(
    threadId: number,
    namespaceId: number,
  ): Promise<void> {
    if (!(await this.isNamespaceActive(namespaceId))) return;
    await this.startThreadPull(threadId, namespaceId);
    await this.wakeCaptured(threadId, namespaceId, 'meta');
  }

  constructor(
    private readonly database: DatabaseService,
    private readonly states: FederationThreadSyncStateService,
    private readonly forward: FederationThreadForwardRoundExecutorService,
    private readonly reverse: FederationThreadReverseRoundExecutorService,
    private readonly meta: FederationThreadMetaRoundExecutorService,
    private readonly peerLifecycle: FederationPeerLifecycle,
    private readonly statePull: FederationStatePullService,
    private readonly threadQueryDenials: FederationThreadQueryDenialService,
    private readonly sources: FederationThreadSourceService,
    private readonly keypair: KeypairService,
    private readonly quota: QuotaService,
    private readonly runtime: FederationPeerRuntimeService,
  ) {
    this.tasks = new FederationThreadTaskQueue(
      {
        allows: (namespaceId) => this.runtime.getCooldown(namespaceId) === null,
        execute: (task) => this.execute(task),
        failed: async (task, error) => {
          try {
            await this.handleRoundFailure(
              task.threadId,
              task.namespaceId,
              task.direction,
              error,
            );
          } catch (failure) {
            this.logger.error(
              `round failure handling failed: ${(failure as Error).message}`,
            );
          }
        },
      },
      {
        message: DEFAULT_MESSAGE_LIMIT,
        reverse: DEFAULT_REVERSE_LIMIT,
        tombstone: DEFAULT_TOMBSTONE_LIMIT,
        meta: DEFAULT_META_LIMIT,
      },
    );
  }

  @OnEvent(FEDERATION_NAMESPACE_PAUSED, { suppressErrors: false })
  async onNamespacePaused(
    event: FederationNamespaceSchedulingEvent,
  ): Promise<void> {
    const drain = this.stateDrains.get(event.namespaceId);
    this.stateDrains.delete(event.namespaceId);
    drain?.controller.abort();
    await this.tasks.cancelNamespace(event.namespaceId);
  }

  @OnEvent(FEDERATION_NAMESPACE_RESUMED, { suppressErrors: false })
  async onNamespaceResumed(
    event: FederationNamespaceSchedulingEvent,
  ): Promise<void> {
    if (this.runtime.getCooldown(event.namespaceId) !== null) return;
    void this.wakeStateFeed(event.namespaceId, 0n);
    await this.recoverPendingRounds(event.namespaceId);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.keypair.waitUntilInitialized();
    await this.recoverPendingRounds();
    const peers = await this.database.db.query.identityNamespace.findMany({
      where: and(
        eq(identityNamespace.active, true),
        eq(identityNamespace.trustLevel, 'available'),
      ),
      columns: { id: true },
    });
    for (const peer of peers) void this.wakeStateFeed(peer.id, 0n);
  }

  /** Authored confirmations are published after commit, when initialized sources are visible. */
  @OnEvent(FEDERATION_STATE_FEED_PUSH)
  async onRelationshipStatePublished(
    event: FederationStateFeedPush,
  ): Promise<void> {
    try {
      await this.recoverPendingRounds(event.namespaceId);
    } catch (error) {
      this.logger.warn(
        `relationship round recovery failed: ${(error as Error).message}`,
      );
    }
  }

  private async recoverPendingRounds(namespaceId?: number): Promise<void> {
    const rows = await this.database.db
      .select({
        threadId: federationThreadSyncState.threadId,
        namespaceId: federationThreadSyncState.namespaceId,
        threadType: messageThread.type,
        authorityNamespaceId: messageThread.authorityNamespaceId,
        messageTargetSeq: federationThreadSyncState.messageTargetSeq,
        deletionTargetSeq: federationThreadSyncState.deletionTargetSeq,
        messageProcessedThroughSeq:
          federationThreadSyncState.messageProcessedThroughSeq,
        deletionProcessedThroughSeq:
          federationThreadSyncState.deletionProcessedThroughSeq,
        reverseCoveredThroughSeq: sql<number>`GREATEST(
          COALESCE((
            SELECT MAX(m."originSeq") FROM "Message" m
            WHERE m."threadId" = ${federationThreadSyncState.threadId}
              AND m."publisherNamespaceId" = ${federationThreadSyncState.namespaceId}
              AND m."publisherNamespaceId" <> 0
              AND m."originSeq" IS NOT NULL
          ), 0),
          COALESCE((
            SELECT MAX(gap."endSeq") FROM "FederationThreadHistoryGap" gap
            WHERE gap."threadId" = ${federationThreadSyncState.threadId}
              AND gap."namespaceId" = ${federationThreadSyncState.namespaceId}
          ), 0)
        )::integer`,
        reversePending: sql<boolean>`EXISTS (
          SELECT 1 FROM "FederationThreadHistoryGap" gap
          WHERE gap."threadId" = ${federationThreadSyncState.threadId}
            AND gap."namespaceId" = ${federationThreadSyncState.namespaceId}
            AND gap.recoverable = true
        )`,
      })
      .from(federationThreadSyncState)
      .innerJoin(
        messageThread,
        eq(messageThread.id, federationThreadSyncState.threadId),
      )
      .innerJoin(
        identityNamespace,
        eq(identityNamespace.id, federationThreadSyncState.namespaceId),
      )
      .where(
        and(
          namespaceId === undefined
            ? undefined
            : eq(federationThreadSyncState.namespaceId, namespaceId),
          eq(messageThread.federationRoundsEnabled, true),
          sql`${federationThreadSyncState.authorizationEpoch} = ${messageThread.authorizationEpoch}`,
          or(
            and(
              eq(messageThread.type, 'GROUP'),
              eq(messageThread.authorityNamespaceId, 0),
              gt(
                federationThreadSyncState.messageTargetSeq,
                federationThreadSyncState.messageProcessedThroughSeq,
              ),
            ),
            and(
              or(
                eq(messageThread.type, 'P2P'),
                gt(messageThread.authorityNamespaceId, 0),
              ),
              sql`${federationThreadSyncState.messageTargetSeq} > GREATEST(
                COALESCE((
                  SELECT MAX(m."originSeq") FROM "Message" m
                  WHERE m."threadId" = ${federationThreadSyncState.threadId}
                    AND m."publisherNamespaceId" = ${federationThreadSyncState.namespaceId}
                    AND m."publisherNamespaceId" <> 0
                    AND m."originSeq" IS NOT NULL
                ), 0),
                COALESCE((
                  SELECT MAX(gap."endSeq") FROM "FederationThreadHistoryGap" gap
                  WHERE gap."threadId" = ${federationThreadSyncState.threadId}
                    AND gap."namespaceId" = ${federationThreadSyncState.namespaceId}
                ), 0)
              )`,
            ),
            gt(
              federationThreadSyncState.deletionTargetSeq,
              federationThreadSyncState.deletionProcessedThroughSeq,
            ),
            sql`EXISTS (
              SELECT 1 FROM "FederationThreadHistoryGap" gap
              WHERE gap."threadId" = ${federationThreadSyncState.threadId}
                AND gap."namespaceId" = ${federationThreadSyncState.namespaceId}
                AND gap.recoverable = true
            )`,
          ),
        ),
      );
    for (const state of rows) {
      try {
        await this.sources.resolve(state.threadId, state.namespaceId);
      } catch (error) {
        if (error instanceof FederationMessageContextError) {
          this.logger.debug(
            `skipped startup recovery for thread ${state.threadId} from namespace ${state.namespaceId}: ${error.message}`,
          );
          continue;
        }
        throw error;
      }
      const isForward =
        state.threadType === 'GROUP' && state.authorityNamespaceId === 0;
      const messageBehind = isForward
        ? state.messageProcessedThroughSeq < state.messageTargetSeq
        : state.reverseCoveredThroughSeq < state.messageTargetSeq;
      const deletionBehind =
        state.deletionProcessedThroughSeq < state.deletionTargetSeq;
      const reversePending = state.reversePending;
      if (messageBehind || deletionBehind || reversePending)
        void this.startThreadPull(state.threadId, state.namespaceId, {
          messages: messageBehind || reversePending,
          tombstones: deletionBehind,
        });
    }
    // Mirrored Group Meta progress lives on GroupMeta, not on the thread sync
    // state, so its pending rounds recover from their own query.
    const metaRows = await this.database.db.execute<{
      threadId: number;
      namespaceId: number;
    }>(sql`
      SELECT feed."threadId", ns.id AS "namespaceId"
      FROM "GroupMeta" feed
      JOIN "MessageThread" thread ON thread.id = feed."threadId"
      JOIN "IdentityNamespace" ns ON ns.id = thread."authorityNamespaceId"
      WHERE feed."metaProcessedThroughId" < feed."metaTargetId"
        AND ns.active = true
        AND thread."federationRoundsEnabled" = true
        ${namespaceId === undefined ? sql`` : sql`AND ns.id = ${namespaceId}`}
    `);
    for (const row of metaRows.rows)
      void this.wakeCaptured(row.threadId, row.namespaceId, 'meta');
  }

  @OnEvent(FEDERATION_THREAD_ROUND_WAKE)
  onWake(event: FederationThreadRoundWake): void {
    if (event.mode === 'meta') {
      void this.wakeCaptured(event.threadId, event.namespaceId, 'meta');
      return;
    }
    if (event.mode !== 'thread') {
      throw new FederationThreadRoundDirectionError(
        'thread pull wake must not select a message direction',
      );
    }
    void this.startThreadPull(event.threadId, event.namespaceId);
  }

  /** Callers only name the thread. This method selects one message direction. */
  private async startThreadPull(
    threadId: number,
    namespaceId: number,
    demand: { messages: boolean; tombstones: boolean } = {
      messages: true,
      tombstones: true,
    },
  ): Promise<void> {
    if (this.shuttingDown) return;
    let source;
    try {
      source = await this.sources.resolve(threadId, namespaceId);
    } catch (error) {
      if (
        error instanceof FederationMessageContextError ||
        error instanceof FederationThreadSourceInactiveError
      ) {
        this.logger.debug(
          `discarded thread pull for ${threadId} from namespace ${namespaceId}: ${(error as Error).message}`,
        );
        return;
      }
      throw error;
    }
    const submissions = source.kind === 'GROUP' && source.localGroupAuthority;
    if (demand.messages)
      await this.wakeCaptured(
        threadId,
        namespaceId,
        submissions ? 'message' : 'reverse',
      );
    if (demand.tombstones)
      await this.wakeCaptured(threadId, namespaceId, 'tombstone');
  }

  async wakeStateFeed(
    namespaceId: number,
    stateFeedEndId: bigint,
  ): Promise<void> {
    if (this.shuttingDown || this.runtime.getCooldown(namespaceId) !== null)
      return;
    const current = this.stateDrains.get(namespaceId);
    if (current) {
      if (stateFeedEndId > current.target) current.target = stateFeedEndId;
      return current.completion;
    }
    const controller = new AbortController();
    const completion = Promise.resolve().then(async () => {
      try {
        for (;;) {
          controller.signal.throwIfAborted();
          this.runtime.assertBusinessAllowed(namespaceId);
          const committedThrough = await this.statePull.pullStateFromPeer(
            namespaceId,
            drain.target,
            controller.signal,
          );
          controller.signal.throwIfAborted();
          if (committedThrough >= drain.target) return;
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          if (error instanceof QuotaPausedError) {
            await this.runtime.enterCooldown(
              namespaceId,
              error.message,
              error.retryAfter,
            );
          } else if (error instanceof FederationCooldownError) {
            this.logger.debug(
              `state-feed drain namespace ${namespaceId} paused: ${error.message}`,
            );
            return;
          }
          this.logger.warn(
            `state-feed drain namespace ${namespaceId} failed: ${(error as Error).message}`,
          );
        }
      } finally {
        if (this.stateDrains.get(namespaceId) === drain)
          this.stateDrains.delete(namespaceId);
        this.activeTasks.delete(completion);
      }
    });
    const drain = { target: stateFeedEndId, controller, completion };
    this.stateDrains.set(namespaceId, drain);
    this.activeTasks.add(completion);
    return completion;
  }

  private async wakeCaptured(
    threadId: number,
    namespaceId: number,
    direction: Direction,
  ): Promise<void> {
    if (this.shuttingDown) return;
    await this.tasks.wake(threadId, namespaceId, direction, true);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    const drains = [...this.stateDrains.values()];
    this.stateDrains.clear();
    for (const drain of drains) drain.controller.abort();
    await this.tasks.shutdown();
    await Promise.allSettled([...this.activeTasks]);
  }

  private async execute(task: FederationThreadTask): Promise<boolean> {
    const { direction, threadId, namespaceId, dirty, signal } = task;
    signal.throwIfAborted();
    this.runtime.assertBusinessAllowed(namespaceId);
    if (direction === 'message' || direction === 'reverse') {
      const source = await this.sources.resolve(threadId, namespaceId);
      const submissions = source.kind === 'GROUP' && source.localGroupAuthority;
      if (
        (direction === 'reverse' && submissions) ||
        (direction === 'message' && !submissions)
      ) {
        throw new FederationThreadRoundDirectionError(
          `${direction} queue does not match the source of thread ${threadId}`,
        );
      }
      await this.quota.assertCanPullMessages(namespaceId);
    }
    let shouldContinue: boolean;
    if (direction === 'message') {
      const previous = await this.states.require(threadId, namespaceId);
      await this.forward.runMessages(
        threadId,
        namespaceId,
        signal,
        FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
      );
      const state = await this.states.require(threadId, namespaceId);
      shouldContinue =
        state.messageProcessedThroughSeq < state.messageTargetSeq;
      if (
        state.messageProcessedThroughSeq > previous.messageProcessedThroughSeq
      )
        void this.wakeCaptured(threadId, namespaceId, 'tombstone');
    } else if (direction === 'tombstone') {
      const result = await this.forward.runTombstones(
        threadId,
        namespaceId,
        signal,
        FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
      );
      // Exhausting a cutoff is not applying all advertised deletions. Do not
      // spin on that durable difference while waiting for stored messages.
      shouldContinue = result.hasMore === true;
    } else if (direction === 'meta') {
      shouldContinue = await this.meta.run(threadId, namespaceId, signal);
    } else {
      const result = await this.reverse.run(
        threadId,
        namespaceId,
        signal,
        FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
        dirty,
      );
      if (result.committed)
        void this.wakeCaptured(threadId, namespaceId, 'tombstone');
      const remainingGap = await this.states.resolveReverseWindow(
        threadId,
        namespaceId,
      );
      shouldContinue = remainingGap !== null;
    }
    signal.throwIfAborted();
    return shouldContinue;
  }

  private async handleRoundFailure(
    threadId: number,
    namespaceId: number,
    direction: Direction,
    error: unknown,
  ): Promise<void> {
    const wrapped =
      error instanceof FederationThreadRoundRemoteError ? error : null;
    const cause = wrapped?.remoteCause ?? error;
    if (cause instanceof FederationThreadRoundDirectionError) {
      this.logger.error(
        `${direction} round rejected for thread ${threadId} from namespace ${namespaceId}: ${cause.message}`,
      );
      return;
    }
    if (
      cause instanceof FederationMessageContextError ||
      cause instanceof FederationCooldownError
    ) {
      this.logger.debug(
        `stopped ${direction} round for thread ${threadId} from namespace ${namespaceId}: ${cause.message}`,
      );
      return;
    }
    if (
      direction === 'meta' &&
      cause instanceof S2sResponseError &&
      cause.code === BusinessCode.FORBIDDEN
    ) {
      this.logger.debug(
        `meta round forbidden for thread ${threadId} from namespace ${namespaceId}; waiting for the next push`,
      );
      return;
    }
    if (
      cause instanceof S2sResponseError &&
      cause.code === BusinessCode.FORBIDDEN
    ) {
      this.logger.debug(
        `${direction} round forbidden for thread ${threadId} from namespace ${namespaceId}`,
      );
      if (wrapped) {
        try {
          const outcome =
            await this.threadQueryDenials.handleThreadQueryForbidden(
              threadId,
              namespaceId,
              wrapped.authorizationEpoch,
            );
          if (outcome === 'STALE') {
            void this.wakeStateFeed(namespaceId, 0n);
            return;
          }
          await this.tasks.cancelSource(threadId, namespaceId);
          if (outcome === 'MIRROR_WAITING_FOR_PUSH') {
            this.logger.debug(
              `stopped forbidden mirror thread ${threadId} from namespace ${namespaceId}; waiting for the next push`,
            );
            return;
          }
          this.logger.debug(
            `stopped forbidden federation thread ${threadId} from namespace ${namespaceId}: ${outcome}`,
          );
        } catch (handlerError) {
          this.logger.error(
            `failed to converge forbidden federation thread ${threadId} from namespace ${namespaceId}: ${(handlerError as Error).message}`,
          );
          return;
        }
      } else {
        await this.tasks.cancelSource(threadId, namespaceId);
      }
      void this.wakeStateFeed(namespaceId, 0n);
      return;
    }
    if (cause instanceof FederationThreadRoundAuthorizationEpochChangedError) {
      this.logger.debug(
        `stale ${direction} round for thread ${threadId} from namespace ${namespaceId}: ${cause.message}`,
      );
    } else {
      this.logger.warn(
        `${direction} round failed for thread ${threadId}: ${(error as Error).message}`,
      );
    }
    if (cause instanceof QuotaPausedError) {
      await this.runtime.enterCooldown(
        namespaceId,
        cause.message,
        cause.retryAfter,
      );
    }
    // No task-local retry. Durable targets survive removal; namespace recovery
    // or a subsequent committed state change reconstructs the work.
    return;
  }

  private async isNamespaceActive(namespaceId: number): Promise<boolean> {
    const [peer] = await this.database.db
      .select({ id: identityNamespace.id })
      .from(identityNamespace)
      .where(
        and(
          eq(identityNamespace.id, namespaceId),
          eq(identityNamespace.active, true),
          sql`${identityNamespace.retiredAt} IS NULL`,
        ),
      )
      .limit(1);
    return peer !== undefined;
  }
}
