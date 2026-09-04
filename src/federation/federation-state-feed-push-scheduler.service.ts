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
  private readonly dirty = new Set<string>();
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
    for (const peerDomain of await this.federation.listTrustedPeerDomains())
      this.schedule(peerDomain);
  }

  @OnEvent(FEDERATION_STATE_FEED_PUSH)
  onPush(event: FederationStateFeedPush): void {
    this.schedule(event.peerDomain);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.dirty.clear();
    await Promise.allSettled([...this.activeTasks]);
  }

  private schedule(peerDomain: string): void {
    if (this.shuttingDown) return;
    this.dirty.add(peerDomain);
    if (this.active.has(peerDomain) || this.timers.has(peerDomain)) return;
    const delay = Math.max(
      0,
      (this.lastAttemptAt.get(peerDomain) ?? 0) + MIN_INTERVAL_MS - Date.now(),
    );
    const timer = setTimeout(() => {
      this.timers.delete(peerDomain);
      this.run(peerDomain);
    }, delay);
    timer.unref?.();
    this.timers.set(peerDomain, timer);
  }

  private run(peerDomain: string): void {
    if (this.shuttingDown || !this.dirty.delete(peerDomain)) return;
    this.active.add(peerDomain);
    this.lastAttemptAt.set(peerDomain, Date.now());
    const task = this.client
      .send(peerDomain)
      .catch((error: unknown) => {
        this.logger.warn(
          `state-feed head push ${peerDomain} failed: ${(error as Error).message}`,
        );
        if (shouldRetry(error)) this.dirty.add(peerDomain);
      })
      .finally(() => {
        this.active.delete(peerDomain);
        this.activeTasks.delete(task);
        if (this.dirty.has(peerDomain)) this.schedule(peerDomain);
      });
    this.activeTasks.add(task);
  }
}

function shouldRetry(error: unknown): boolean {
  if (error instanceof BusinessException) return false;
  if (error instanceof S2sResponseError)
    return isRetryableFederationNetworkError(error);
  return true;
}
