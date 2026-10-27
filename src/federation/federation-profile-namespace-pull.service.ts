import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { federationFeedState } from '../database/schema.js';
import { SseService } from '../gateway/sse.service.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';
import { ProfileNamespaceFeedConsumerService } from './profile-namespace-feed-consumer.service.js';
import { ProfileNamespaceFeedPullService } from './profile-namespace-feed-pull.service.js';
import type { ProfileNamespaceItemEffect } from './profile-namespace-feed-consumer.service.js';
import type { ProfileNamespaceFeedPage } from './profile-namespace-feed.service.js';
import { ProfileNamespaceRefreshService } from './profile-namespace-refresh.service.js';

/** Owns bounded Profile Namespace Feed drains: fetch pages over the trusted
 *  peer channel, apply items through the consumer, advance the per-peer
 *  cursor, and schedule cache refreshes plus client notification after each
 *  commit. */
@Injectable()
export class FederationProfileNamespacePullService {
  private readonly logger = new Logger(
    FederationProfileNamespacePullService.name,
  );

  constructor(
    private readonly database: DatabaseService,
    private readonly peerHttp: FederationPeerHttp,
    private readonly trustedPeers: FederationTrustedPeerClient,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly feedPull: ProfileNamespaceFeedPullService,
    private readonly consumer: ProfileNamespaceFeedConsumerService,
    private readonly sse: SseService,
    private readonly namespaceRefresh: ProfileNamespaceRefreshService,
  ) {}

  async pullFeedPage(
    domain: string,
    after?: bigint,
    take?: number,
    through?: bigint,
  ): Promise<ProfileNamespaceFeedPage> {
    if (
      (after === undefined && (take !== undefined || through !== undefined)) ||
      (after !== undefined && after < 0n) ||
      (after !== undefined && through !== undefined && through < after) ||
      (take !== undefined &&
        (!Number.isInteger(take) || take < 1 || take > 200))
    )
      throw new Error('invalid profile namespace feed cursor/page size');
    const query = new URLSearchParams();
    if (after !== undefined) query.set('after', after.toString());
    if (take !== undefined) query.set('take', take.toString());
    if (through !== undefined) query.set('through', through.toString());
    return this.trustedPeers.run(domain, () =>
      this.peerHttp.get<ProfileNamespaceFeedPage>(
        `/s2s/v1/profile-namespace-feed${
          query.size === 0 ? '' : `?${query.toString()}`
        }`,
        domain,
        4 * 1024 * 1024,
      ),
    );
  }

  /** Drain the peer's Profile Namespace Feed up to an advertised end when
   *  supplied. Returns the committed cursor. */
  async pullFromPeer(domain: string, requiredEnd?: bigint): Promise<bigint> {
    const context = await this.threadAccess.capturePeerResponseToken(domain);
    if (requiredEnd !== undefined)
      this.feedPull.advertise(domain, context.namespaceId, requiredEnd);
    await this.feedPull.run(domain, context.namespaceId, {
      fetch: async (after, through) =>
        this.pullFeedPage(domain, after, 100, through),
      apply: async (tx, item) => {
        const feedId = BigInt(item.feedId);
        return this.consumer.applyItemInTx(tx, context.namespaceId, {
          namespaceId: item.namespaceId,
          feedId,
        });
      },
      afterCommit: async (effect: ProfileNamespaceItemEffect) => {
        this.sse.notifyProfileNamespaceChange(effect.clientChangeId);
        if (effect.expiredLocalRows) {
          this.namespaceRefresh.scheduleRefresh(
            {
              publisherNamespaceId: effect.publisherNamespaceId,
              profileNamespaceId: effect.profileNamespaceId,
            },
            effect.triggerFeedId,
          );
        }
      },
    });
    const cursor = await this.readPulledThrough(domain, context.namespaceId);
    if (requiredEnd !== undefined && cursor < requiredEnd)
      throw new Error(
        `profile namespace feed for ${domain} stopped at ${cursor.toString()} before required end ${requiredEnd.toString()}`,
      );
    return cursor;
  }

  /** Wake hook for push hints and envelope observations: record the head and
   *  start a drain when behind. */
  wake(domain: string, advertisedEnd: bigint): void {
    void this.pullFromPeer(domain, advertisedEnd).catch((error: unknown) =>
      this.logger.warn(
        `profile namespace pull failed for ${domain}: ${(error as Error).message}`,
      ),
    );
  }

  /** Compares an observed publisher head with the local cursor and wakes the
   *  drain only when actually behind. */
  async wakeIfBehind(domain: string, observedEnd: bigint): Promise<void> {
    const context = await this.threadAccess.capturePeerResponseToken(domain);
    const cursor = await this.readPulledThrough(domain, context.namespaceId);
    if (cursor < observedEnd) this.wake(domain, observedEnd);
  }

  private async readPulledThrough(
    domain: string,
    namespaceId: number,
  ): Promise<bigint> {
    const [row] = await this.database.db
      .select({
        pulledThrough:
          federationFeedState.inboundProfileNamespaceFeedPulledThrough,
      })
      .from(federationFeedState)
      .where(eq(federationFeedState.namespaceId, namespaceId))
      .limit(1);
    if (!row) throw new Error(`peer ${domain} has no namespace row`);
    return row.pulledThrough;
  }
}
