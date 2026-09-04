import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { and, eq } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import {
  federationThreadSyncState,
  federatedPeer,
  identityNamespace,
  messageThread,
} from '../database/schema.js';
import {
  FederationMessageContextError,
  S2sResponseError,
} from './federation-errors.js';
import { FederationThreadForwardRoundExecutorService } from './federation-thread-forward-round-executor.service.js';
import {
  FEDERATION_THREAD_ROUND_WAKE,
  type FederationThreadRoundWake,
} from './federation-thread-round.events.js';
import { FederationThreadReverseRoundExecutorService } from './federation-thread-reverse-round-executor.service.js';
import { FEDERATION_THREAD_ROUND_DEFAULT_TAKE } from './federation-thread-round.constants.js';
import { FederationThreadRoundRemoteError } from './federation-thread-round-error.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { FederationService } from './federation.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';

type Direction = 'message' | 'tombstone' | 'reverse';

interface DirectionQueue {
  active: number;
  readonly activeThreads: Set<string>;
  readonly queuedThreads: Set<string>;
  readonly dirtyThreads: Set<string>;
  readonly byPeer: Map<
    string,
    Array<{ threadId: number; namespaceId: number }>
  >;
  readonly peerOrder: string[];
  lastServedPeer: string | null;
}

const DEFAULT_MESSAGE_LIMIT = 4;
const DEFAULT_TOMBSTONE_LIMIT = 4;
const DEFAULT_REVERSE_LIMIT = 2;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;

/** Fair, process-local scheduler for bounded per-thread synchronization rounds. */
@Injectable()
export class FederationThreadRoundSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(
    FederationThreadRoundSchedulerService.name,
  );
  private readonly queues: Record<Direction, DirectionQueue> = {
    message: this.createQueue(),
    tombstone: this.createQueue(),
    reverse: this.createQueue(),
  };
  private readonly limits: Record<Direction, number> = {
    message: DEFAULT_MESSAGE_LIMIT,
    tombstone: DEFAULT_TOMBSTONE_LIMIT,
    reverse: DEFAULT_REVERSE_LIMIT,
  };
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly blockedThreads = new Set<string>();
  private readonly inactiveThreads = new Set<string>();
  private readonly stateDrainTargets = new Map<string, bigint>();
  private readonly stateDrainActive = new Set<string>();
  private readonly stateDrainRetryAttempts = new Map<string, number>();
  private readonly stateDrainRetryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private shuttingDown = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly states: FederationThreadSyncStateService,
    private readonly forward: FederationThreadForwardRoundExecutorService,
    private readonly reverse: FederationThreadReverseRoundExecutorService,
    private readonly federation: FederationService,
    private readonly sources: FederationThreadSourceService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.database.db
      .select({
        threadId: federationThreadSyncState.threadId,
        peerDomain: identityNamespace.domain,
        namespaceId: messageThread.authorityNamespaceId,
        messageTargetSeq: federationThreadSyncState.messageTargetSeq,
        deletionTargetSeq: federationThreadSyncState.deletionTargetSeq,
        messageProcessedThroughSeq:
          federationThreadSyncState.messageProcessedThroughSeq,
        deletionProcessedThroughSeq:
          federationThreadSyncState.deletionProcessedThroughSeq,
        historyBoundaryReached:
          federationThreadSyncState.historyBoundaryReached,
      })
      .from(federationThreadSyncState)
      .innerJoin(
        messageThread,
        eq(messageThread.id, federationThreadSyncState.threadId),
      )
      .innerJoin(
        identityNamespace,
        eq(identityNamespace.id, messageThread.authorityNamespaceId),
      )
      .innerJoin(
        federatedPeer,
        and(
          eq(federatedPeer.domain, identityNamespace.domain),
          eq(
            federatedPeer.activeNamespaceId,
            messageThread.authorityNamespaceId,
          ),
        ),
      );
    for (const state of rows) {
      try {
        await this.sources.resolve(
          state.threadId,
          state.peerDomain,
          state.namespaceId,
        );
      } catch (error) {
        if (error instanceof FederationMessageContextError) {
          this.logger.debug(
            `skipped startup recovery for thread ${state.threadId} from ${state.peerDomain}: ${error.message}`,
          );
          continue;
        }
        throw error;
      }
      if (state.messageProcessedThroughSeq < state.messageTargetSeq)
        void this.wakeCaptured(
          state.threadId,
          state.peerDomain,
          state.namespaceId,
          'message',
        );
      if (state.deletionProcessedThroughSeq < state.deletionTargetSeq) {
        void this.wakeCaptured(
          state.threadId,
          state.peerDomain,
          state.namespaceId,
          'tombstone',
        );
      }
      if (!state.historyBoundaryReached)
        void this.wakeCaptured(
          state.threadId,
          state.peerDomain,
          state.namespaceId,
          'reverse',
        );
    }
    for (const peerDomain of await this.federation.listTrustedPeerDomains())
      this.wakeStateFeed(peerDomain, 0n);
  }

  @OnEvent(FEDERATION_THREAD_ROUND_WAKE)
  onWake(event: FederationThreadRoundWake): void {
    const key = this.workKey(
      event.threadId,
      event.peerDomain,
      event.namespaceId,
    );
    if (this.inactiveThreads.has(key)) return;
    this.blockedThreads.delete(key);
    if (event.direction === 'both') {
      void this.wakeCaptured(
        event.threadId,
        event.peerDomain,
        event.namespaceId,
        'message',
      );
      void this.wakeCaptured(
        event.threadId,
        event.peerDomain,
        event.namespaceId,
        'tombstone',
      );
      void this.wakeCaptured(
        event.threadId,
        event.peerDomain,
        event.namespaceId,
        'reverse',
      );
      return;
    }
    if (event.direction === 'forward') {
      void this.wakeCaptured(
        event.threadId,
        event.peerDomain,
        event.namespaceId,
        'message',
      );
      void this.wakeCaptured(
        event.threadId,
        event.peerDomain,
        event.namespaceId,
        'tombstone',
      );
      return;
    }
    void this.wakeCaptured(
      event.threadId,
      event.peerDomain,
      event.namespaceId,
      'reverse',
    );
  }

  wakeStateFeed(peerDomain: string, stateFeedEndId: bigint): void {
    if (this.shuttingDown) return;
    const current = this.stateDrainTargets.get(peerDomain);
    if (current === undefined || stateFeedEndId > current)
      this.stateDrainTargets.set(peerDomain, stateFeedEndId);
    if (
      this.stateDrainActive.has(peerDomain) ||
      this.stateDrainRetryTimers.has(peerDomain)
    )
      return;
    this.runStateFeedDrain(peerDomain);
  }

  async wake(
    threadId: number,
    peerDomain: string,
    direction: Direction,
  ): Promise<void> {
    const [context] = await this.database.db
      .select({
        peerDomain: identityNamespace.domain,
        namespaceId: messageThread.authorityNamespaceId,
      })
      .from(messageThread)
      .innerJoin(
        identityNamespace,
        eq(identityNamespace.id, messageThread.authorityNamespaceId),
      )
      .where(eq(messageThread.id, threadId))
      .limit(1);
    if (!context || context.peerDomain !== peerDomain) {
      this.logger.debug(
        `discarded stale wake for thread ${threadId} from ${peerDomain}`,
      );
      return;
    }
    return this.wakeCaptured(
      threadId,
      peerDomain,
      context.namespaceId,
      direction,
    );
  }

  private async wakeCaptured(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    direction: Direction,
  ): Promise<void> {
    if (this.shuttingDown) return;
    const queue = this.queues[direction];
    const workKey = this.workKey(threadId, peerDomain, namespaceId);
    if (this.blockedThreads.has(workKey) || this.inactiveThreads.has(workKey))
      return;
    if (queue.activeThreads.has(workKey)) {
      queue.dirtyThreads.add(workKey);
      return;
    }
    if (queue.queuedThreads.has(workKey)) return;
    const peerQueue = queue.byPeer.get(peerDomain);
    if (peerQueue) peerQueue.push({ threadId, namespaceId });
    else {
      queue.byPeer.set(peerDomain, [{ threadId, namespaceId }]);
      queue.peerOrder.push(peerDomain);
    }
    queue.queuedThreads.add(workKey);
    this.pump(direction);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    for (const timer of this.stateDrainRetryTimers.values())
      clearTimeout(timer);
    this.stateDrainRetryTimers.clear();
    this.stateDrainTargets.clear();
    this.blockedThreads.clear();
    this.inactiveThreads.clear();
    for (const queue of Object.values(this.queues)) {
      queue.byPeer.clear();
      queue.peerOrder.length = 0;
      queue.queuedThreads.clear();
      queue.dirtyThreads.clear();
    }
    await Promise.allSettled([...this.activeTasks]);
  }

  private runStateFeedDrain(peerDomain: string): void {
    if (this.shuttingDown || this.stateDrainActive.has(peerDomain)) return;
    const target = this.stateDrainTargets.get(peerDomain);
    if (target === undefined) return;
    this.stateDrainActive.add(peerDomain);
    const task = this.federation
      .pullStateFromPeer(peerDomain, target)
      .then((committedThrough) => {
        this.stateDrainRetryAttempts.delete(peerDomain);
        const latest = this.stateDrainTargets.get(peerDomain);
        if (latest !== undefined && latest <= committedThrough)
          this.stateDrainTargets.delete(peerDomain);
      })
      .catch((error: unknown) => {
        this.logger.warn(
          `state-feed drain ${peerDomain} failed: ${(error as Error).message}`,
        );
        const decision = this.retryDecision(error);
        if (decision.retry)
          this.scheduleStateFeedDrainRetry(peerDomain, decision.delayMs);
        else this.stateDrainTargets.delete(peerDomain);
      })
      .finally(() => {
        this.stateDrainActive.delete(peerDomain);
        this.activeTasks.delete(task);
        if (
          this.stateDrainTargets.has(peerDomain) &&
          !this.stateDrainRetryTimers.has(peerDomain)
        )
          queueMicrotask(() => this.runStateFeedDrain(peerDomain));
      });
    this.activeTasks.add(task);
  }

  private scheduleStateFeedDrainRetry(
    peerDomain: string,
    minimumDelayMs = 0,
  ): void {
    if (this.shuttingDown || this.stateDrainRetryTimers.has(peerDomain)) return;
    const attempt = (this.stateDrainRetryAttempts.get(peerDomain) ?? 0) + 1;
    this.stateDrainRetryAttempts.set(peerDomain, attempt);
    const delay = this.retryDelay(attempt, minimumDelayMs);
    const timer = setTimeout(() => {
      this.stateDrainRetryTimers.delete(peerDomain);
      this.runStateFeedDrain(peerDomain);
    }, delay);
    timer.unref?.();
    this.stateDrainRetryTimers.set(peerDomain, timer);
  }

  private pump(direction: Direction): void {
    if (this.shuttingDown) return;
    const queue = this.queues[direction];
    while (queue.active < this.limits[direction]) {
      const selected = this.takeNext(queue);
      if (!selected) return;
      queue.active += 1;
      const workKey = this.workKey(
        selected.threadId,
        selected.peerDomain,
        selected.namespaceId,
      );
      queue.activeThreads.add(workKey);
      let requeue = false;
      const task = this.execute(
        direction,
        selected.threadId,
        selected.peerDomain,
        selected.namespaceId,
      )
        .then((shouldContinue) => {
          requeue = shouldContinue;
        })
        .catch(async (error: unknown) => {
          this.logger.warn(
            `${direction} round failed for thread ${selected.threadId}: ${(error as Error).message}`,
          );
          requeue = await this.handleRoundFailure(
            selected.threadId,
            selected.peerDomain,
            selected.namespaceId,
            direction,
            error,
          );
        })
        .finally(() => {
          queue.active -= 1;
          queue.activeThreads.delete(workKey);
          this.activeTasks.delete(task);
          if (requeue)
            queueMicrotask(
              () =>
                void this.wakeCaptured(
                  selected.threadId,
                  selected.peerDomain,
                  selected.namespaceId,
                  direction,
                ),
            );
          this.pump(direction);
        });
      this.activeTasks.add(task);
    }
  }

  private async execute(
    direction: Direction,
    threadId: number,
    peerDomain: string,
    namespaceId: number,
  ): Promise<boolean> {
    const queue = this.queues[direction];
    const workKey = this.workKey(threadId, peerDomain, namespaceId);
    queue.dirtyThreads.delete(workKey);
    if (direction === 'message') {
      await this.forward.runMessages(
        threadId,
        peerDomain,
        namespaceId,
        FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
      );
    } else if (direction === 'tombstone') {
      await this.forward.runTombstones(
        threadId,
        peerDomain,
        namespaceId,
        FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
      );
    } else {
      await this.reverse.run(
        threadId,
        peerDomain,
        namespaceId,
        FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
      );
    }
    this.clearRetry(threadId, peerDomain, namespaceId, direction);
    const dirty = queue.dirtyThreads.delete(workKey);
    const state = await this.states.require(threadId);
    const shouldContinue =
      direction === 'message'
        ? state.messageProcessedThroughSeq < state.messageTargetSeq
        : direction === 'tombstone'
          ? state.deletionProcessedThroughSeq < state.deletionTargetSeq
          : !state.historyBoundaryReached;
    return shouldContinue || dirty;
  }

  private takeNext(
    queue: DirectionQueue,
  ): { peerDomain: string; threadId: number; namespaceId: number } | null {
    if (
      queue.peerOrder.length > 1 &&
      queue.peerOrder[0] === queue.lastServedPeer
    )
      queue.peerOrder.push(queue.peerOrder.shift()!);
    while (queue.peerOrder.length > 0) {
      const peerDomain = queue.peerOrder.shift()!;
      const peerQueue = queue.byPeer.get(peerDomain);
      if (!peerQueue?.length) {
        queue.byPeer.delete(peerDomain);
        continue;
      }
      const selected = peerQueue.shift()!;
      queue.queuedThreads.delete(
        this.workKey(selected.threadId, peerDomain, selected.namespaceId),
      );
      if (peerQueue.length > 0) queue.peerOrder.push(peerDomain);
      else queue.byPeer.delete(peerDomain);
      queue.lastServedPeer = peerDomain;
      return { peerDomain, ...selected };
    }
    return null;
  }

  private scheduleRetry(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    direction: Direction,
    minimumDelayMs = 0,
  ): void {
    if (this.shuttingDown) return;
    const key = this.retryKey(threadId, peerDomain, namespaceId, direction);
    if (this.retries.has(key)) return;
    const attempt = (this.retryAttempts.get(key) ?? 0) + 1;
    this.retryAttempts.set(key, attempt);
    const delay = this.retryDelay(attempt, minimumDelayMs);
    const timer = setTimeout(() => {
      this.retries.delete(key);
      void this.retryIfActive(threadId, peerDomain, namespaceId, direction);
    }, delay);
    timer.unref?.();
    this.retries.set(key, timer);
  }

  private async retryIfActive(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    direction: Direction,
  ): Promise<void> {
    if (await this.isNamespaceActive(peerDomain, namespaceId)) {
      await this.wakeCaptured(threadId, peerDomain, namespaceId, direction);
      return;
    }
    const key = this.workKey(threadId, peerDomain, namespaceId);
    this.inactiveThreads.add(key);
    this.retryAttempts.delete(
      this.retryKey(threadId, peerDomain, namespaceId, direction),
    );
    this.queues[direction].dirtyThreads.delete(key);
    this.logger.log(
      `discarded ${direction} retry for inactive namespace ${namespaceId} of ${peerDomain}`,
    );
  }

  private async handleRoundFailure(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    direction: Direction,
    error: unknown,
  ): Promise<boolean> {
    const wrapped =
      error instanceof FederationThreadRoundRemoteError ? error : null;
    const cause = wrapped?.remoteCause ?? error;
    if (
      cause instanceof S2sResponseError &&
      cause.code === BusinessCode.FORBIDDEN
    ) {
      if (wrapped) {
        try {
          const outcome = await this.federation.handleThreadQueryForbidden(
            threadId,
            peerDomain,
            namespaceId,
            wrapped.authorizationEpoch,
          );
          if (outcome === 'STALE') {
            this.wakeStateFeed(peerDomain, 0n);
            return true;
          }
          this.blockThread(threadId, peerDomain, namespaceId);
          this.logger.warn(
            `stopped forbidden federation thread ${threadId} from ${peerDomain}: ${outcome}`,
          );
        } catch (handlerError) {
          this.logger.error(
            `failed to converge forbidden federation thread ${threadId} from ${peerDomain}: ${(handlerError as Error).message}`,
          );
          this.scheduleRetry(threadId, peerDomain, namespaceId, direction);
          return false;
        }
      } else {
        this.blockThread(threadId, peerDomain, namespaceId);
      }
      this.wakeStateFeed(peerDomain, 0n);
      return false;
    }
    const decision = this.retryDecision(cause);
    if (decision.retry) {
      if (!(await this.isNamespaceActive(peerDomain, namespaceId))) {
        const key = this.workKey(threadId, peerDomain, namespaceId);
        this.inactiveThreads.add(key);
        this.queues[direction].dirtyThreads.delete(key);
        this.clearRetry(threadId, peerDomain, namespaceId, direction);
        this.logger.log(
          `discarded ${direction} retry for inactive namespace ${namespaceId} of ${peerDomain}`,
        );
        return false;
      }
      this.scheduleRetry(
        threadId,
        peerDomain,
        namespaceId,
        direction,
        decision.delayMs,
      );
      return false;
    }
    this.logger.error(
      `stopped permanent ${direction} failure for federation thread ${threadId} from ${peerDomain}: ${(cause as Error).message}`,
    );
    return false;
  }

  private async isNamespaceActive(
    peerDomain: string,
    namespaceId: number,
  ): Promise<boolean> {
    const [peer] = await this.database.db
      .select({ domain: federatedPeer.domain })
      .from(federatedPeer)
      .where(
        and(
          eq(federatedPeer.domain, peerDomain),
          eq(federatedPeer.activeNamespaceId, namespaceId),
        ),
      )
      .limit(1);
    return peer !== undefined;
  }

  private retryDecision(error: unknown): { retry: boolean; delayMs: number } {
    if (
      error instanceof BusinessException ||
      error instanceof FederationMessageContextError
    )
      return { retry: false, delayMs: 0 };
    if (!(error instanceof S2sResponseError))
      return { retry: true, delayMs: 0 };
    const retryableCodes = new Set<number>([
      BusinessCode.RATE_LIMITED,
      BusinessCode.INTERNAL,
      BusinessCode.FEDERATION_QUOTA_EXCEEDED,
      BusinessCode.FEDERATION_LOCAL_IDENTITY_LOST,
      BusinessCode.FEDERATION_MESSAGE_QUERY_RATE_LIMITED,
      BusinessCode.FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE,
    ]);
    const retry =
      error.status >= 500 ||
      error.status === 408 ||
      error.status === 429 ||
      (error.code !== undefined && retryableCodes.has(error.code));
    if (!retry) return { retry: false, delayMs: 0 };
    return { retry: true, delayMs: this.retryAfterMs(error.data) };
  }

  private retryAfterMs(data: unknown): number {
    if (typeof data !== 'object' || data === null || Array.isArray(data))
      return 0;
    const retryAfter = (data as Record<string, unknown>)['retryAfter'];
    if (!Number.isSafeInteger(retryAfter) || Number(retryAfter) < 0) return 0;
    return Math.min(2_147_483_647, Number(retryAfter) * 1_000);
  }

  private retryDelay(attempt: number, minimumDelayMs: number): number {
    const exponential = Math.min(
      RETRY_MAX_MS,
      RETRY_BASE_MS * 2 ** (attempt - 1),
    );
    const floor = Math.min(
      2_147_483_647,
      Math.max(minimumDelayMs, exponential),
    );
    if (minimumDelayMs <= 0 || floor >= 2_147_483_647) return floor;
    const jitterWindow = Math.max(1, Math.min(1_000, Math.floor(floor / 10)));
    return Math.min(
      2_147_483_647,
      floor + Math.floor(Math.random() * (jitterWindow + 1)),
    );
  }

  private blockThread(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
  ): void {
    const workKey = this.workKey(threadId, peerDomain, namespaceId);
    this.blockedThreads.add(workKey);
    for (const direction of Object.keys(this.queues) as Direction[]) {
      const queue = this.queues[direction];
      queue.dirtyThreads.delete(workKey);
      queue.queuedThreads.delete(workKey);
      const peerQueue = queue.byPeer.get(peerDomain);
      if (peerQueue) {
        const retained = peerQueue.filter(
          (queued) =>
            queued.threadId !== threadId || queued.namespaceId !== namespaceId,
        );
        if (retained.length > 0) queue.byPeer.set(peerDomain, retained);
        else queue.byPeer.delete(peerDomain);
      }
      this.clearRetry(threadId, peerDomain, namespaceId, direction);
    }
  }

  private clearRetry(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    direction: Direction,
  ): void {
    const key = this.retryKey(threadId, peerDomain, namespaceId, direction);
    const timer = this.retries.get(key);
    if (timer) clearTimeout(timer);
    this.retries.delete(key);
    this.retryAttempts.delete(key);
  }

  private retryKey(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
    direction: Direction,
  ): string {
    return `${direction}:${peerDomain}:${namespaceId}:${threadId}`;
  }

  private workKey(
    threadId: number,
    peerDomain: string,
    namespaceId: number,
  ): string {
    return JSON.stringify([peerDomain, namespaceId, threadId]);
  }

  private createQueue(): DirectionQueue {
    return {
      active: 0,
      activeThreads: new Set(),
      queuedThreads: new Set(),
      dirtyThreads: new Set(),
      byPeer: new Map(),
      peerOrder: [],
      lastServedPeer: null,
    };
  }
}
