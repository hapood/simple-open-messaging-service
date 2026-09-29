import {
  Injectable,
  Logger,
  OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { BusinessException } from '../common/business.exception.js';
import { S2sResponseError } from './federation-errors.js';
import { isRetryableFederationNetworkError } from './federation-http-scheduler.js';
import { FederationService } from './federation.service.js';
import { FederationStateFeedHeadClient } from './federation-state-feed-head-client.service.js';
import {
  FEDERATION_STATE_FEED_PUSH,
  type FederationStateFeedPush,
} from './federation-state-feed.events.js';

const MIN_INTERVAL_MS = 1_000;

/** Coalesces ephemeral State Feed head hints independently for each peer. Each
 * HTTP attempt enters the global/per-peer request pool through FederationPeerHttp. */
@Injectable()
export class FederationStateFeedPushSchedulerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(
    FederationStateFeedPushSchedulerService.name,
  );
  private readonly dirty = new Map<string, FederationStateFeedPush>();
  private readonly active = new Set<string>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastAttemptAt = new Map<string, number>();
  private readonly activeTasks = new Set<Promise<void>>();
  private shuttingDown = false;

  constructor(
    private readonly federation: FederationService,
    private readonly client: FederationStateFeedHeadClient,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.federation.pushStateFeedDomains(
      await this.federation.listTrustedPeerDomains(),
    );
  }

  @OnEvent(FEDERATION_STATE_FEED_PUSH)
  onPush(event: FederationStateFeedPush): void {
    this.schedule(event);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.dirty.clear();
    await Promise.allSettled([...this.activeTasks]);
  }

  private schedule(target: FederationStateFeedPush): void {
    if (this.shuttingDown) return;
    const key = this.key(target);
    this.dirty.set(key, target);
    if (this.active.has(key) || this.timers.has(key)) return;
    const delay = Math.max(
      0,
      (this.lastAttemptAt.get(key) ?? 0) + MIN_INTERVAL_MS - Date.now(),
    );
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.run(key);
    }, delay);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  private run(key: string): void {
    const target = this.dirty.get(key);
    if (this.shuttingDown || !target) return;
    this.dirty.delete(key);
    this.active.add(key);
    this.lastAttemptAt.set(key, Date.now());
    const task = this.federation
      .activePeerDomainForNamespace(target.namespaceId)
      .then((peerDomain) => {
        if (peerDomain === null) return;
        return this.client.send(peerDomain).catch((error: unknown) => {
          this.logger.warn(
            `state-feed head push for namespace ${target.namespaceId} failed: ${(error as Error).message}`,
          );
          if (shouldRetry(error)) this.dirty.set(key, target);
        });
      })
      .finally(() => {
        this.active.delete(key);
        this.activeTasks.delete(task);
        if (this.dirty.has(key)) this.schedule(target);
      });
    this.activeTasks.add(task);
  }

  private key(target: FederationStateFeedPush): string {
    return String(target.namespaceId);
  }
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof BusinessException) return false;
  if (error instanceof S2sResponseError)
    return isRetryableFederationNetworkError(error);
  return true;
}
