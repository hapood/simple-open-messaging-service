import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { DatabaseService } from '../database/database.service.js';
import { federationThreadSyncState } from '../database/schema.js';
import { FederationThreadForwardRoundExecutorService } from './federation-thread-forward-round-executor.service.js';
import {
  FEDERATION_THREAD_ROUND_WAKE,
  type FederationThreadRoundWake,
} from './federation-thread-round.events.js';
import { FederationThreadReverseRoundExecutorService } from './federation-thread-reverse-round-executor.service.js';
import { FEDERATION_THREAD_ROUND_DEFAULT_TAKE } from './federation-thread-round.constants.js';
import { FederationThreadSyncStateService } from './federation-thread-sync-state.service.js';

type Direction = 'forward' | 'reverse';

interface DirectionQueue {
  active: number;
  readonly activeThreads: Set<string>;
  readonly queuedThreads: Set<string>;
  readonly dirtyThreads: Set<string>;
  readonly byPeer: Map<string, number[]>;
  readonly peerOrder: string[];
  lastServedPeer: string | null;
}

const DEFAULT_FORWARD_LIMIT = 4;
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
    forward: this.createQueue(),
    reverse: this.createQueue(),
  };
  private readonly limits: Record<Direction, number> = {
    forward: DEFAULT_FORWARD_LIMIT,
    reverse: DEFAULT_REVERSE_LIMIT,
  };
  private readonly activeTasks = new Set<Promise<void>>();
  private readonly retries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private shuttingDown = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly states: FederationThreadSyncStateService,
    private readonly forward: FederationThreadForwardRoundExecutorService,
    private readonly reverse: FederationThreadReverseRoundExecutorService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const rows = await this.database.db
      .select()
      .from(federationThreadSyncState);
    for (const state of rows) {
      if (
        state.messageProcessedThroughSeq < state.messageTargetSeq ||
        state.deletionProcessedThroughSeq < state.deletionTargetSeq
      )
        void this.wake(state.threadId, state.peerDomain, 'forward');
      if (!state.historyBoundaryReached)
        void this.wake(state.threadId, state.peerDomain, 'reverse');
    }
  }

  @OnEvent(FEDERATION_THREAD_ROUND_WAKE)
  onWake(event: FederationThreadRoundWake): void {
    if (event.direction === 'both') {
      void this.wake(event.threadId, event.peerDomain, 'forward');
      void this.wake(event.threadId, event.peerDomain, 'reverse');
      return;
    }
    void this.wake(event.threadId, event.peerDomain, event.direction);
  }

  async wake(
    threadId: number,
    peerDomain: string,
    direction: Direction,
  ): Promise<void> {
    if (this.shuttingDown) return;
    const queue = this.queues[direction];
    const workKey = this.workKey(threadId, peerDomain);
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
    for (const queue of Object.values(this.queues)) {
      queue.byPeer.clear();
      queue.peerOrder.length = 0;
      queue.queuedThreads.clear();
      queue.dirtyThreads.clear();
    }
    await Promise.allSettled([...this.activeTasks]);
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
        .catch((error: unknown) => {
          this.logger.warn(
            `${direction} round failed for thread ${selected.threadId}: ${(error as Error).message}`,
          );
          this.scheduleRetry(selected.threadId, selected.peerDomain, direction);
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
    const result =
      direction === 'forward'
        ? await this.forward.run(
            threadId,
            peerDomain,
            FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
          )
        : await this.reverse.run(
            threadId,
            peerDomain,
            FEDERATION_THREAD_ROUND_DEFAULT_TAKE,
          );
    this.clearRetry(threadId, peerDomain, direction);
    const dirty = queue.dirtyThreads.delete(workKey);
    const state = await this.states.require(threadId, peerDomain);
    const shouldContinue =
      direction === 'forward'
        ? !result.blockedByPending &&
          (state.messageProcessedThroughSeq < state.messageTargetSeq ||
            state.deletionProcessedThroughSeq < state.deletionTargetSeq)
        : !state.historyBoundaryReached && (!result.blockedByPending || dirty);
    return shouldContinue || (direction === 'forward' && dirty);
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
  ): void {
    if (this.shuttingDown) return;
    const key = this.retryKey(threadId, peerDomain, direction);
    if (this.retries.has(key)) return;
    const attempt = (this.retryAttempts.get(key) ?? 0) + 1;
    this.retryAttempts.set(key, attempt);
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempt - 1));
    const timer = setTimeout(() => {
      this.retries.delete(key);
      void this.wake(threadId, peerDomain, direction);
    }, delay);
    timer.unref?.();
    this.retries.set(key, timer);
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
