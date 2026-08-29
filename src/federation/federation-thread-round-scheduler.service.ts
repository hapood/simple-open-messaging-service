import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { DatabaseService } from '../database/database.service.js';
import { federationThreadSyncState } from '../database/schema.js';
import {
  FederationMessageContextError,
  S2sResponseError,
} from './federation-errors.js';
import { FederationThreadForwardRoundExecutorService } from './federation-thread-forward-round-executor.service.js';
import {
  FEDERATION_STATE_FEED_PUSH,
  FEDERATION_THREAD_ROUND_WAKE,
  type FederationStateFeedPush,
  type FederationThreadRoundWake,
} from './federation-thread-round.events.js';
import { FederationThreadReverseRoundExecutorService } from './federation-thread-reverse-round-executor.service.js';
import { FEDERATION_THREAD_ROUND_DEFAULT_TAKE } from './federation-thread-round.constants.js';
import { FederationThreadRoundRemoteError } from './federation-thread-round-error.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';
import { FederationService } from './federation.service.js';
import { FederationThreadSourceService } from './federation-thread-source.service.js';

type Direction = 'message' | 'tombstone' | 'reverse';

interface TombstoneHeadPair {
  feedId: bigint;
  messageEndSeq: number;
  tombstoneEndSeq: number;
  maxMessageSeq: number;
}

interface DirectionQueue {
  active: number;
  readonly activeThreads: Set<string>;
  readonly queuedThreads: Set<string>;
  readonly dirtyThreads: Set<string>;
  readonly byPeer: Map<string, number[]>;
  readonly peerOrder: string[];
  lastServedPeer: string | null;
}

const DEFAULT_MESSAGE_LIMIT = 4;
const DEFAULT_TOMBSTONE_LIMIT = 4;
const DEFAULT_REVERSE_LIMIT = 2;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 60_000;
const STATE_PUSH_MIN_INTERVAL_MS = 1_000;

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
  private readonly tombstoneHeads = new Map<string, TombstoneHeadPair>();
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly blockedThreads = new Set<string>();
  private readonly statePushDirty = new Set<string>();
  private readonly statePushActive = new Set<string>();
  private readonly statePushTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly statePushLastAttemptAt = new Map<string, number>();
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
      .select()
      .from(federationThreadSyncState);
    for (const state of rows) {
      try {
        await this.sources.resolve(state.threadId, state.peerDomain);
      } catch (error) {
        if (error instanceof FederationMessageContextError) continue;
        throw error;
      }
      if (state.messageProcessedThroughSeq < state.messageTargetSeq)
        void this.wake(state.threadId, state.peerDomain, 'message');
      if (state.deletionProcessedThroughSeq < state.deletionTargetSeq) {
        this.rememberTombstoneHead(state.threadId, state.peerDomain, {
          feedId: 0n,
          messageEndSeq: state.messageTargetSeq,
          tombstoneEndSeq: state.deletionTargetSeq,
          maxMessageSeq: state.messageTargetSeq,
        });
        void this.wake(state.threadId, state.peerDomain, 'tombstone');
      }
      if (!state.historyBoundaryReached)
        void this.wake(state.threadId, state.peerDomain, 'reverse');
    }
    for (const peerDomain of await this.federation.listTrustedPeerDomains()) {
      this.scheduleStateFeedPush(peerDomain);
      this.wakeStateFeed(peerDomain, 0n);
    }
  }

  @OnEvent(FEDERATION_THREAD_ROUND_WAKE)
  onWake(event: FederationThreadRoundWake): void {
    this.blockedThreads.delete(this.workKey(event.threadId, event.peerDomain));
    if (event.head) {
      this.rememberTombstoneHead(event.threadId, event.peerDomain, {
        feedId: BigInt(event.head.feedId),
        messageEndSeq: event.head.messageEndSeq,
        tombstoneEndSeq: event.head.tombstoneEndSeq,
        maxMessageSeq: event.head.tombstoneMaxMessageSeq,
      });
    }
    if (event.direction === 'both') {
      void this.wake(event.threadId, event.peerDomain, 'message');
      void this.wake(event.threadId, event.peerDomain, 'tombstone');
      void this.wake(event.threadId, event.peerDomain, 'reverse');
      return;
    }
    if (event.direction === 'forward') {
      void this.wake(event.threadId, event.peerDomain, 'message');
      void this.wake(event.threadId, event.peerDomain, 'tombstone');
      return;
    }
    void this.wake(event.threadId, event.peerDomain, 'reverse');
  }

  @OnEvent(FEDERATION_STATE_FEED_PUSH)
  onStateFeedPush(event: FederationStateFeedPush): void {
    this.scheduleStateFeedPush(event.peerDomain);
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
    if (this.shuttingDown) return;
    const queue = this.queues[direction];
    const workKey = this.workKey(threadId, peerDomain);
    if (this.blockedThreads.has(workKey)) return;
    if (queue.activeThreads.has(workKey)) {
      queue.dirtyThreads.add(workKey);
      return;
    }
    if (queue.queuedThreads.has(workKey)) return;
    const peerQueue = queue.byPeer.get(peerDomain);
    if (peerQueue) peerQueue.push(threadId);
    else {
      queue.byPeer.set(peerDomain, [threadId]);
      queue.peerOrder.push(peerDomain);
    }
    queue.queuedThreads.add(workKey);
    this.pump(direction);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
    for (const timer of this.statePushTimers.values()) clearTimeout(timer);
    this.statePushTimers.clear();
    this.statePushDirty.clear();
    for (const timer of this.stateDrainRetryTimers.values())
      clearTimeout(timer);
    this.stateDrainRetryTimers.clear();
    this.stateDrainTargets.clear();
    this.tombstoneHeads.clear();
    this.blockedThreads.clear();
    for (const queue of Object.values(this.queues)) {
      queue.byPeer.clear();
      queue.peerOrder.length = 0;
      queue.queuedThreads.clear();
      queue.dirtyThreads.clear();
    }
    await Promise.allSettled([...this.activeTasks]);
  }

  private scheduleStateFeedPush(peerDomain: string): void {
    if (this.shuttingDown) return;
    this.statePushDirty.add(peerDomain);
    if (
      this.statePushActive.has(peerDomain) ||
      this.statePushTimers.has(peerDomain)
    )
      return;
    const delay = Math.max(
      0,
      (this.statePushLastAttemptAt.get(peerDomain) ?? 0) +
        STATE_PUSH_MIN_INTERVAL_MS -
        Date.now(),
    );
    const timer = setTimeout(() => {
      this.statePushTimers.delete(peerDomain);
      this.runStateFeedPush(peerDomain);
    }, delay);
    timer.unref?.();
    this.statePushTimers.set(peerDomain, timer);
  }

  private runStateFeedPush(peerDomain: string): void {
    if (this.shuttingDown || !this.statePushDirty.delete(peerDomain)) return;
    this.statePushActive.add(peerDomain);
    this.statePushLastAttemptAt.set(peerDomain, Date.now());
    const task = this.federation
      .pushDiscoveryHwm(peerDomain)
      .catch((error: unknown) => {
        this.logger.warn(
          `state-feed HWM push ${peerDomain} failed: ${(error as Error).message}`,
        );
        if (this.retryDecision(error).retry)
          this.statePushDirty.add(peerDomain);
      })
      .finally(() => {
        this.statePushActive.delete(peerDomain);
        this.activeTasks.delete(task);
        if (this.statePushDirty.has(peerDomain))
          this.scheduleStateFeedPush(peerDomain);
      });
    this.activeTasks.add(task);
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
    const delay = Math.min(
      2_147_483_647,
      Math.max(
        minimumDelayMs,
        Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)),
      ),
    );
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
      const workKey = this.workKey(selected.threadId, selected.peerDomain);
      queue.activeThreads.add(workKey);
      let requeue = false;
      const task = this.execute(
        direction,
        selected.threadId,
        selected.peerDomain,
      )
        .then((shouldContinue) => {
          requeue = shouldContinue;
        })
        .catch(async (error: unknown) => {
          this.logger.warn(
            `${direction} round failed for thread ${selected.threadId}: ${(error as Error).message}`,
          );
          await this.handleRoundFailure(
            selected.threadId,
            selected.peerDomain,
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
                void this.wake(
                  selected.threadId,
                  selected.peerDomain,
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
  ): Promise<boolean> {
    const queue = this.queues[direction];
    const workKey = this.workKey(threadId, peerDomain);
    queue.dirtyThreads.delete(workKey);
    if (direction === 'message') {
      await this.forward.runMessages(
        threadId,
        peerDomain,
        FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
      );
    } else if (direction === 'tombstone') {
      let head = this.tombstoneHeads.get(workKey);
      if (!head) {
        const state = await this.states.require(threadId, peerDomain);
        head = {
          feedId: 0n,
          messageEndSeq: state.messageTargetSeq,
          tombstoneEndSeq: state.deletionTargetSeq,
          maxMessageSeq: state.messageTargetSeq,
        };
        this.tombstoneHeads.set(workKey, head);
      }
      await this.forward.runTombstones(
        threadId,
        peerDomain,
        head.tombstoneEndSeq,
        head.maxMessageSeq,
        FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
      );
    } else {
      await this.reverse.run(
        threadId,
        peerDomain,
        FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
      );
    }
    this.clearRetry(threadId, peerDomain, direction);
    const dirty = queue.dirtyThreads.delete(workKey);
    const state = await this.states.require(threadId, peerDomain);
    const shouldContinue =
      direction === 'message'
        ? state.messageProcessedThroughSeq < state.messageTargetSeq
        : direction === 'tombstone'
          ? state.deletionProcessedThroughSeq <
            (this.tombstoneHeads.get(workKey)?.tombstoneEndSeq ??
              state.deletionTargetSeq)
          : !state.historyBoundaryReached;
    return shouldContinue || dirty;
  }

  private rememberTombstoneHead(
    threadId: number,
    peerDomain: string,
    pair: TombstoneHeadPair,
  ): void {
    const key = this.workKey(threadId, peerDomain);
    const current = this.tombstoneHeads.get(key);
    if (current && current.feedId > pair.feedId) return;
    this.tombstoneHeads.set(key, pair);
  }

  private takeNext(
    queue: DirectionQueue,
  ): { peerDomain: string; threadId: number } | null {
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
      const threadId = peerQueue.shift()!;
      queue.queuedThreads.delete(this.workKey(threadId, peerDomain));
      if (peerQueue.length > 0) queue.peerOrder.push(peerDomain);
      else queue.byPeer.delete(peerDomain);
      queue.lastServedPeer = peerDomain;
      return { peerDomain, threadId };
    }
    return null;
  }

  private scheduleRetry(
    threadId: number,
    peerDomain: string,
    direction: Direction,
    minimumDelayMs = 0,
  ): void {
    if (this.shuttingDown) return;
    const key = this.retryKey(threadId, peerDomain, direction);
    if (this.retries.has(key)) return;
    const attempt = (this.retryAttempts.get(key) ?? 0) + 1;
    this.retryAttempts.set(key, attempt);
    const delay = Math.min(
      2_147_483_647,
      Math.max(
        minimumDelayMs,
        Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1)),
      ),
    );
    const timer = setTimeout(() => {
      this.retries.delete(key);
      void this.wake(threadId, peerDomain, direction);
    }, delay);
    timer.unref?.();
    this.retries.set(key, timer);
  }

  private async handleRoundFailure(
    threadId: number,
    peerDomain: string,
    direction: Direction,
    error: unknown,
  ): Promise<void> {
    const wrapped =
      error instanceof FederationThreadRoundRemoteError ? error : null;
    const cause = wrapped?.remoteCause ?? error;
    if (
      cause instanceof S2sResponseError &&
      cause.code === BusinessCode.FORBIDDEN
    ) {
      this.blockThread(threadId, peerDomain);
      if (wrapped) {
        try {
          const outcome = await this.federation.handleThreadQueryForbidden(
            threadId,
            peerDomain,
            wrapped.authorizationEpoch,
          );
          this.logger.warn(
            `stopped forbidden federation thread ${threadId} from ${peerDomain}: ${outcome}`,
          );
        } catch (handlerError) {
          this.blockedThreads.delete(this.workKey(threadId, peerDomain));
          this.logger.error(
            `failed to converge forbidden federation thread ${threadId} from ${peerDomain}: ${(handlerError as Error).message}`,
          );
          this.scheduleRetry(threadId, peerDomain, direction);
          return;
        }
      }
      this.wakeStateFeed(peerDomain, 0n);
      return;
    }
    const decision = this.retryDecision(cause);
    if (decision.retry) {
      this.scheduleRetry(threadId, peerDomain, direction, decision.delayMs);
      return;
    }
    this.logger.error(
      `stopped permanent ${direction} failure for federation thread ${threadId} from ${peerDomain}: ${(cause as Error).message}`,
    );
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

  private blockThread(threadId: number, peerDomain: string): void {
    const workKey = this.workKey(threadId, peerDomain);
    this.blockedThreads.add(workKey);
    this.tombstoneHeads.delete(workKey);
    for (const direction of Object.keys(this.queues) as Direction[]) {
      const queue = this.queues[direction];
      queue.dirtyThreads.delete(workKey);
      queue.queuedThreads.delete(workKey);
      const peerQueue = queue.byPeer.get(peerDomain);
      if (peerQueue) {
        const retained = peerQueue.filter((queued) => queued !== threadId);
        if (retained.length > 0) queue.byPeer.set(peerDomain, retained);
        else queue.byPeer.delete(peerDomain);
      }
      this.clearRetry(threadId, peerDomain, direction);
    }
  }

  private clearRetry(
    threadId: number,
    peerDomain: string,
    direction: Direction,
  ): void {
    const key = this.retryKey(threadId, peerDomain, direction);
    const timer = this.retries.get(key);
    if (timer) clearTimeout(timer);
    this.retries.delete(key);
    this.retryAttempts.delete(key);
  }

  private retryKey(
    threadId: number,
    peerDomain: string,
    direction: Direction,
  ): string {
    return `${direction}:${peerDomain}:${threadId}`;
  }

  private workKey(threadId: number, peerDomain: string): string {
    return JSON.stringify([peerDomain, threadId]);
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
