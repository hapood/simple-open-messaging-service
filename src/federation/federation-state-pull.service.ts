import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { eq } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { ClientStateFeedService } from '../client-state-feed/client-state-feed.service.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';
import { FederationLocalSystemMessagePublisher } from './federation-local-system-message-publisher.service.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { S2sResponseError } from './federation-errors.js';
import { FEDERATION_STATE_FEED_PUSH } from './federation-state-feed.events.js';
import { FEDERATION_THREAD_ROUND_WAKE } from './federation-thread-round.events.js';
import {
  FederationStateFeedConsumerService,
  type StatePageEffect,
} from './federation-state-feed-consumer.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import { FederationProfileNamespacePullService } from './federation-profile-namespace-pull.service.js';
import { ProfileResolutionCoordinatorService } from '../profile-resolution/profile-resolution-coordinator.service.js';
import type { PeerStateFeedPage } from './peer-state-feed.service.js';

/** Owns bounded State Feed drains. Dependent Group Meta is materialized by durable tasks. */
@Injectable()
export class FederationStatePullService {
  private readonly logger = new Logger(FederationStatePullService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly peerHttp: FederationPeerHttp,
    private readonly trustedPeers: FederationTrustedPeerClient,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly stateFeedPull: PeerStateFeedPullService,
    private readonly stateFeedConsumer: FederationStateFeedConsumerService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly systemMessages: FederationLocalSystemMessagePublisher,
    private readonly profileResolutions: ProfileResolutionCoordinatorService,
    private readonly profileNamespacePull: FederationProfileNamespacePullService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async pullStateFeedPage(
    domain: string,
    after?: bigint,
    take?: number,
    through?: bigint,
  ): Promise<PeerStateFeedPage> {
    if (
      (after === undefined && (take !== undefined || through !== undefined)) ||
      (after !== undefined && after < 0n) ||
      (after !== undefined && through !== undefined && through < after) ||
      (take !== undefined &&
        (!Number.isInteger(take) || take < 1 || take > 200))
    )
      throw new Error('invalid state feed cursor/page size');
    const query = new URLSearchParams();
    if (after !== undefined) query.set('after', after.toString());
    if (take !== undefined) query.set('take', take.toString());
    if (through !== undefined) query.set('through', through.toString());
    try {
      return await this.trustedPeers.run(domain, () =>
        this.peerHttp.get<PeerStateFeedPage>(
          `/s2s/v1/state-feed${query.size === 0 ? '' : `?${query.toString()}`}`,
          domain,
          16 * 1024 * 1024,
        ),
      );
    } catch (error) {
      throw this.mapFeedCursorUnavailable(error);
    }
  }

  /** Drain state before data feeds and durably reach an advertised revision when supplied. */
  async pullStateFromPeer(
    domain: string,
    requiredRevision?: bigint,
  ): Promise<bigint> {
    const context = await this.threadAccess.capturePeerResponseToken(domain);
    if (requiredRevision !== undefined)
      this.stateFeedPull.advertise(
        domain,
        context.namespaceId,
        requiredRevision,
      );
    const changed = new WeakMap<PeerStateFeedPage, StatePageEffect>();
    let observedProfileNamespaceEnd: bigint | undefined;
    await this.stateFeedPull.run(domain, context.namespaceId, {
      fetch: async (after, through) => {
        const page = await this.pullStateFeedPage(
          domain,
          after,
          after === undefined ? undefined : 100,
          through,
        );
        // Ordinary pulls observe the Profile Namespace Feed head from the
        // page envelope; a behind cursor wakes that drain after this one.
        const observed = page.profileNamespaceFeedEndId;
        if (typeof observed === 'string' && /^(0|[1-9]\d*)$/.test(observed)) {
          const value = BigInt(observed);
          if (
            observedProfileNamespaceEnd === undefined ||
            value > observedProfileNamespaceEnd
          )
            observedProfileNamespaceEnd = value;
        }
        return page;
      },
      apply: async (tx, page) => {
        const result = await this.stateFeedConsumer.applyPageInTx(
          tx,
          domain,
          context.namespaceId,
          page,
        );
        changed.set(page, result);
      },
      afterCommit: async (page) => {
        const effect = changed.get(page) ?? {
          clientFeedUpdates: [],
          statePushNamespaces: [],
          localSystemMessages: [],
          threadRoundWakes: [],
          profileDemands: [],
        };
        await this.publishEffect(effect);
      },
    });
    const cursor = await this.readStatePullCursor(domain, context.namespaceId);
    if (requiredRevision !== undefined && cursor < requiredRevision)
      throw new Error(
        `state feed for ${domain} stopped at ${cursor.toString()} before required revision ${requiredRevision.toString()}`,
      );
    if (
      observedProfileNamespaceEnd !== undefined &&
      observedProfileNamespaceEnd > 0n
    )
      await this.profileNamespacePull.wakeIfBehind(
        domain,
        observedProfileNamespaceEnd,
      );
    return cursor;
  }

  async publishEffect(
    effect: import('./federation-state-feed-consumer.service.js').StatePageEffect,
  ): Promise<void> {
    this.clientStateFeed.notifyFeedUpdates(effect.clientFeedUpdates);
    for (const namespaceId of new Set(effect.statePushNamespaces))
      this.eventEmitter.emit(FEDERATION_STATE_FEED_PUSH, { namespaceId });
    for (const status of effect.localSystemMessages)
      await this.systemMessages.publish(status);
    for (const wake of effect.threadRoundWakes)
      this.eventEmitter.emit(FEDERATION_THREAD_ROUND_WAKE, wake);
    for (const demand of effect.profileDemands) {
      if (demand.target.rev === 0) continue;
      void this.profileResolutions
        .resolveDemand(demand)
        .catch((error: unknown) => {
          // Post-commit preloading may outlive the intent authorizing it.
          if (
            error instanceof BusinessException &&
            error.bizCode === BusinessCode.NOT_FOUND
          )
            return;
          this.logger.warn(
            `profile resolution failed for account ${demand.target.account}, revision ${demand.target.rev}: ${(error as Error).message}`,
          );
        });
    }
  }

  private mapFeedCursorUnavailable(error: unknown): Error {
    if (
      error instanceof S2sResponseError &&
      error.code === BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE
    ) {
      const data = error.data;
      if (
        typeof data === 'object' &&
        data !== null &&
        !Array.isArray(data) &&
        Object.keys(data).length === 2 &&
        Object.hasOwn(data, 'resumeAfter') &&
        Object.hasOwn(data, 'resumeBefore')
      ) {
        const cursor = data as {
          resumeAfter?: unknown;
          resumeBefore?: unknown;
        };
        if (
          typeof cursor.resumeAfter === 'string' &&
          /^(0|[1-9]\d*)$/.test(cursor.resumeAfter) &&
          typeof cursor.resumeBefore === 'string' &&
          /^(0|[1-9]\d*)$/.test(cursor.resumeBefore)
        )
          return new RemoteFeedCursorUnavailableError(
            BigInt(cursor.resumeAfter),
            BigInt(cursor.resumeBefore),
          );
      }
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  private async readStatePullCursor(
    domain: string,
    namespaceId: number,
  ): Promise<bigint> {
    const [row] = await this.database.db
      .select({
        pulledThrough: tables.identityNamespace.stateFeedPulledThrough,
      })
      .from(tables.identityNamespace)
      .where(eq(tables.identityNamespace.id, namespaceId))
      .limit(1);
    if (!row) throw new Error(`peer ${domain} has no namespace row`);
    // NULL is the never-bootstrapped marker: nothing has been drained yet.
    return row.pulledThrough ?? 0n;
  }
}
