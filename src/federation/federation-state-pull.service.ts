import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { and, eq, sql } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import {
  ClientStateFeedService,
  type PendingClientStateFeedUpdate,
} from '../client-state-feed/client-state-feed.service.js';
import { DatabaseService } from '../database/database.service.js';
import * as tables from '../database/schema.js';
import { RemoteFeedCursorUnavailableError } from './federation-feed-cursor-error.js';
import { FederationLocalSystemMessagePublisher } from './federation-local-system-message-publisher.service.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { S2sResponseError } from './federation-errors.js';
import {
  FEDERATION_STATE_FEED_PUSH,
  FEDERATION_THREAD_ROUND_WAKE,
} from './federation-thread-round.events.js';
import { FederationStateFeedConsumerService } from './federation-state-feed-consumer.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { FederationThreadContentHeadService } from './federation-thread-content-head.service.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';
import type { GroupMetaFeedPage } from './group-meta-feed.service.js';
import { PeerStateFeedPullService } from './peer-state-feed-pull.service.js';
import {
  PeerStateFeedService,
  type PeerStateFeedPage,
} from './peer-state-feed.service.js';

/** Owns bounded State Feed drains and their dependent group-meta snapshots. */
@Injectable()
export class FederationStatePullService {
  private readonly logger = new Logger(FederationStatePullService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly peerHttp: FederationPeerHttp,
    private readonly trustedPeers: FederationTrustedPeerClient,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly stateFeedPull: PeerStateFeedPullService,
    private readonly stateFeedConsumer: FederationStateFeedConsumerService,
    private readonly threadContentHeads: FederationThreadContentHeadService,
    private readonly clientStateFeed: ClientStateFeedService,
    private readonly systemMessages: FederationLocalSystemMessagePublisher,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /** Publish the current compacted State Feed head as an ephemeral wake-up. */
  async pushDiscoveryHwm(domain: string): Promise<void> {
    const context = await this.threadAccess.capturePeerResponseToken(domain);
    const stateFeedEndId = await this.stateFeed.readFeedEndId(
      context.namespaceId,
    );
    await this.peerHttp.post(
      '/s2s/v1/feed-heads',
      JSON.stringify({ stateFeedEndId: stateFeedEndId.toString() }),
      domain,
    );
  }

  async rebuildAndPushDiscoveryHwm(domain: string): Promise<void> {
    await this.threadContentHeads.fill(domain);
    await this.pushDiscoveryHwm(domain);
  }

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
    const changed = new WeakMap<
      PeerStateFeedPage,
      Awaited<ReturnType<FederationStateFeedConsumerService['applyPageInTx']>>
    >();
    const groupMetaPages = new WeakMap<
      PeerStateFeedPage,
      Map<string, GroupMetaFeedPage>
    >();
    const groupMetaPagesByFeedId = new Map<
      string,
      Map<string, GroupMetaFeedPage>
    >();
    const drainClientFeedUpdates: PendingClientStateFeedUpdate[] = [];
    await this.stateFeedPull.run(domain, context.namespaceId, {
      fetch: async (after, through) => {
        const page = await this.pullStateFeedPage(
          domain,
          after,
          after === undefined ? undefined : 100,
          through,
        );
        const prefetched = await this.prefetchGroupMetaFeeds(
          domain,
          context.namespaceId,
          page,
        );
        groupMetaPages.set(page, prefetched);
        for (const item of page.items)
          groupMetaPagesByFeedId.set(item.feedId, prefetched);
        return page;
      },
      beginRebuild: async (tx) => {
        await tx.execute(sql`
          UPDATE "Group" mirror_group
          SET "remoteGroupMetaFeedId" = NULL, "updatedAt" = NOW()
          WHERE mirror_group.domain = ${domain}
            AND mirror_group."namespaceId" = ${context.namespaceId}
        `);
      },
      apply: async (tx, page) => {
        changed.set(
          page,
          await this.stateFeedConsumer.applyPageInTx(
            tx,
            domain,
            context.namespaceId,
            page,
            groupMetaPages.get(page) ??
              groupMetaPagesByFeedId.get(page.items[0]?.feedId ?? ''),
          ),
        );
      },
      afterCommit: async (page) => {
        const effect = changed.get(page) ?? {
          clientFeedUpdates: [],
          statePushDomains: [],
          localSystemMessages: [],
          threadRoundWakes: [],
        };
        drainClientFeedUpdates.push(...effect.clientFeedUpdates);
        this.pushStateFeedDomains(effect.statePushDomains);
        for (const status of effect.localSystemMessages)
          await this.systemMessages.publish(status);
        for (const wake of effect.threadRoundWakes)
          this.eventEmitter.emit(FEDERATION_THREAD_ROUND_WAKE, wake);
        const feedId = page.items[0]?.feedId;
        if (feedId !== undefined) groupMetaPagesByFeedId.delete(feedId);
      },
      afterDrain: async () => {
        this.clientStateFeed.notifyFeedUpdates(drainClientFeedUpdates);
      },
    });
    const cursor = await this.readStatePullCursor(domain, context.namespaceId);
    if (requiredRevision !== undefined && cursor < requiredRevision)
      throw new Error(
        `state feed for ${domain} stopped at ${cursor.toString()} before required revision ${requiredRevision.toString()}`,
      );
    return cursor;
  }

  private pushStateFeedDomains(domains: Iterable<string>): void {
    for (const peerDomain of new Set(domains))
      this.eventEmitter.emit(FEDERATION_STATE_FEED_PUSH, { peerDomain });
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

  private async pullGroupMetaFeed(
    domain: string,
    account: string,
    mode: 'full' | 'delta',
    after: bigint,
    fixedThrough?: bigint,
  ): Promise<GroupMetaFeedPage> {
    let cursor = after;
    let through = fixedThrough;
    const items: GroupMetaFeedPage['items'] = [];
    for (;;) {
      const requestedAfter = cursor;
      const query = new URLSearchParams({
        account,
        mode,
        after: cursor.toString(),
        take: '100',
      });
      if (through !== undefined) query.set('through', through.toString());
      let page: GroupMetaFeedPage;
      try {
        page = await this.trustedPeers.run(domain, () =>
          this.peerHttp.get<GroupMetaFeedPage>(
            `/s2s/v1/group-meta?${query.toString()}`,
            domain,
            16 * 1024 * 1024,
          ),
        );
      } catch (error) {
        if (
          mode === 'delta' &&
          error instanceof S2sResponseError &&
          error.code === BusinessCode.FEDERATION_FEED_CURSOR_UNAVAILABLE
        ) {
          const recovery = error.data as {
            resumeAfter?: unknown;
            resumeBefore?: unknown;
          };
          if (
            typeof recovery?.resumeAfter !== 'string' ||
            !/^(0|[1-9]\d*)$/.test(recovery.resumeAfter) ||
            typeof recovery.resumeBefore !== 'string' ||
            !/^[1-9]\d*$/.test(recovery.resumeBefore) ||
            BigInt(recovery.resumeBefore) <= BigInt(recovery.resumeAfter)
          )
            throw new Error('invalid group-meta recovery window');
          this.logger.warn(
            `group-meta cursor for ${account}@${domain} is unavailable; rebuilding from ${recovery.resumeAfter} through ${(BigInt(recovery.resumeBefore) - 1n).toString()}`,
          );
          return this.pullGroupMetaFeed(
            domain,
            account,
            'full',
            BigInt(recovery.resumeAfter),
            BigInt(recovery.resumeBefore) - 1n,
          );
        }
        throw error;
      }
      if (
        page.account !== account ||
        page.mode !== mode ||
        !/^(0|[1-9]\d*)$/.test(page.scannedThrough) ||
        !/^(0|[1-9]\d*)$/.test(page.groupMetaFeedEndId)
      )
        throw new Error('invalid group-meta page');
      const scannedThrough = BigInt(page.scannedThrough);
      const pageEnd = BigInt(page.groupMetaFeedEndId);
      if (through === undefined) through = pageEnd;
      if (scannedThrough < cursor || scannedThrough > through)
        throw new Error('invalid group-meta scan boundary');
      items.push(...page.items);
      cursor = scannedThrough;
      if (!page.hasMore) {
        if (cursor !== through)
          throw new Error('incomplete group-meta bounded drain');
        return {
          account,
          mode,
          items,
          scannedThrough: cursor.toString(),
          groupMetaFeedEndId: page.groupMetaFeedEndId,
          hasMore: false,
        };
      }
      if (cursor === requestedAfter)
        throw new Error('group-meta pagination made no progress');
    }
  }

  private async prefetchGroupMetaFeeds(
    domain: string,
    namespaceId: number,
    page: PeerStateFeedPage,
  ): Promise<Map<string, GroupMetaFeedPage>> {
    const result = new Map<string, GroupMetaFeedPage>();
    for (const item of page.items) {
      if (item.eventType !== 'GROUP_META_FEED_HEAD') continue;
      const groupMetaFeedEndId = (item.body as { groupMetaFeedEndId?: unknown })
        ?.groupMetaFeedEndId;
      if (
        typeof groupMetaFeedEndId !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(groupMetaFeedEndId)
      )
        throw new Error('invalid GROUP_META_FEED_HEAD body');
      const mirror = await this.database.db
        .select({ remoteGroupMetaFeedId: tables.group.remoteGroupMetaFeedId })
        .from(tables.group)
        .where(
          and(
            eq(tables.group.account, item.account),
            eq(tables.group.domain, domain),
            eq(tables.group.namespaceId, namespaceId),
          ),
        )
        .limit(1);
      const current = mirror[0]?.remoteGroupMetaFeedId;
      if (
        current !== null &&
        current !== undefined &&
        current >= BigInt(groupMetaFeedEndId)
      )
        continue;
      result.set(
        item.account,
        await this.pullGroupMetaFeed(
          domain,
          item.account,
          current === null || current === undefined ? 'full' : 'delta',
          current ?? 0n,
        ),
      );
    }
    return result;
  }

  private async readStatePullCursor(
    domain: string,
    namespaceId: number,
  ): Promise<bigint> {
    const row = await this.database.db.query.peerStateFeedPullCursor.findFirst({
      where: eq(tables.peerStateFeedPullCursor.namespaceId, namespaceId),
      columns: { committedThrough: true },
    });
    if (!row) throw new Error(`peer ${domain} has no state-feed pull cursor`);
    return row.committedThrough;
  }
}
