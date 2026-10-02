import { Injectable, Logger } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { BusinessCode } from '../common/business-code.js';
import { DatabaseService } from '../database/database.service.js';
import { identityNamespace, profileNamespaceInfo } from '../database/schema.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';
import { SseService } from '../gateway/sse.service.js';
import {
  ProfileNamespaceFeedService,
  type ProfileNamespaceBindings,
} from './profile-namespace-feed.service.js';
import { TrailingSingleFlight } from '../../shared/trailing-single-flight.js';
import type { ProfileNamespacePair } from './profile-namespace-info.service.js';

const STALE_FETCH_MAX_ATTEMPTS = 3;

/** Outbound ProfileNamespaceInfo refresh engine: per-(publisher, nsid)
 *  coalesced background refreshes with the stale-response guard. This is the
 *  only network caller of the local cache — the cache store itself
 *  (ProfileNamespaceInfoService) answers from local rows exclusively, which
 *  keeps the provider import graph acyclic. Avatar-request-shaped:
 *  coalescing per pair, in-flight deduplication, no business locks. */
@Injectable()
export class ProfileNamespaceRefreshService {
  private readonly logger = new Logger(ProfileNamespaceRefreshService.name);
  /** Per-pair refresh schedulers: joins concurrent triggers (max
   *  triggerFeedId) and runs one trailing refresh so a higher counter that
   *  lands mid-refresh is still observed without waiting for the next
   *  external wake. Entries are retired once a sequence settles. */
  private readonly refreshFlights = new Map<
    string,
    TrailingSingleFlight<bigint>
  >();

  constructor(
    private readonly database: DatabaseService,
    private readonly peerHttp: FederationPeerHttp,
    private readonly trustedPeers: FederationTrustedPeerClient,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly feed: ProfileNamespaceFeedService,
    private readonly sse: SseService,
  ) {}

  /** Refreshes one cached pair. Direct rows (nsid 0) rewrite from the local
   *  authoritative IdentityNamespace row; third-party rows pull the
   *  publisher's bindings query with the stale-response guard. Fire-and-forget
   *  safe: every caller may race, only one fetch per pair runs at a time. */
  scheduleRefresh(pair: ProfileNamespacePair, triggerFeedId: bigint): void {
    const key = this.pairKey(pair);
    let flight = this.refreshFlights.get(key);
    if (!flight) {
      flight = new TrailingSingleFlight<bigint>(
        (id) =>
          this.refresh(pair, id).catch((error: unknown) => {
            this.logger.warn(
              `profile namespace refresh failed for (${pair.publisherNamespaceId}, ${pair.profileNamespaceId}): ${(error as Error).message}`,
            );
          }),
        (a, b) => (a > b ? a : b),
      );
      this.refreshFlights.set(key, flight);
    }
    const sequence = flight.trigger(triggerFeedId);
    void sequence.finally(() => {
      // Retire the entry only if no new round started meanwhile; a running
      // sequence keeps its entry (a later trigger must join, not fork).
      if (this.refreshFlights.get(key) === flight && !flight.running)
        this.refreshFlights.delete(key);
    });
  }

  private async refresh(
    pair: ProfileNamespacePair,
    triggerFeedId: bigint,
  ): Promise<void> {
    if (pair.profileNamespaceId === 0) {
      await this.refreshDirectRow(pair.publisherNamespaceId);
      return;
    }
    for (let attempt = 1; attempt <= STALE_FETCH_MAX_ATTEMPTS; attempt += 1) {
      const answer = await this.fetchBindings(
        pair.publisherNamespaceId,
        pair.profileNamespaceId,
      );
      // Stale guard: a response whose disclosed feed end is behind the
      // triggering feedId describes the pre-change bindings and must never
      // persist as current.
      const end = BigInt(answer.profileNamespaceFeedEndId);
      if (end < triggerFeedId) continue;
      await this.database.db
        .insert(profileNamespaceInfo)
        .values({
          publisherNamespaceId: pair.publisherNamespaceId,
          profileNamespaceId: pair.profileNamespaceId,
          domain: answer.domain,
          rootPublicKey: answer.rootPublicKey,
          updateFeedId: end,
          expired: false,
        })
        .onConflictDoUpdate({
          target: [
            profileNamespaceInfo.publisherNamespaceId,
            profileNamespaceInfo.profileNamespaceId,
          ],
          set: {
            domain: answer.domain,
            rootPublicKey: answer.rootPublicKey,
            updateFeedId: end,
            expired: false,
          },
        });
      return;
    }
    throw new Error(
      `publisher kept serving bindings behind trigger ${triggerFeedId.toString()}`,
    );
  }

  private async refreshDirectRow(publisherNamespaceId: number): Promise<void> {
    const [row] = await this.database.db
      .select({
        domain: identityNamespace.domain,
        rootPublicKey: identityNamespace.rootPublicKey,
        retiredAt: identityNamespace.retiredAt,
        pulledThrough: identityNamespace.profileNamespaceFeedPulledThrough,
      })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, publisherNamespaceId))
      .limit(1);
    if (!row || row.retiredAt !== null || row.rootPublicKey === null)
      throw new Error(
        `publisher namespace ${publisherNamespaceId} has no authoritative binding`,
      );
    // updateFeedId aligns with the drain progress we have already applied, so
    // feed entries at or below it never re-expire this row. The converged
    // binding is a client-visible change: record it and wake devices, since
    // the drain that scheduled this refresh already expired their copies.
    const changeId = await this.database.db.transaction(async (tx) => {
      await tx
        .insert(profileNamespaceInfo)
        .values({
          publisherNamespaceId,
          profileNamespaceId: 0,
          domain: row.domain,
          rootPublicKey: row.rootPublicKey,
          updateFeedId: row.pulledThrough,
          expired: false,
        })
        .onConflictDoUpdate({
          target: [
            profileNamespaceInfo.publisherNamespaceId,
            profileNamespaceInfo.profileNamespaceId,
          ],
          set: {
            domain: row.domain,
            rootPublicKey: row.rootPublicKey,
            updateFeedId: row.pulledThrough,
            expired: false,
          },
        });
      return this.feed.recordClientChangeInTx(tx, {
        publisherNamespaceId,
        profileNamespaceId: 0,
      });
    });
    this.sse.notifyProfileNamespaceChange(changeId);
  }

  private async fetchBindings(
    publisherNamespaceId: number,
    nsid: number,
  ): Promise<ProfileNamespaceBindings> {
    const [publisher] = await this.database.db
      .select({ domain: identityNamespace.domain })
      .from(identityNamespace)
      .where(eq(identityNamespace.id, publisherNamespaceId))
      .limit(1);
    if (!publisher)
      throw new Error(`publisher namespace ${publisherNamespaceId} is unknown`);
    const context = await this.threadAccess.capturePeerResponseToken(
      publisher.domain,
    );
    try {
      return await this.trustedPeers.run(context.domain, () =>
        this.peerHttp.get<ProfileNamespaceBindings>(
          `/s2s/v1/profile-namespaces/${nsid}`,
          context.domain,
          64 * 1024,
        ),
      );
    } catch (error) {
      if (
        error instanceof S2sResponseError &&
        error.code === BusinessCode.NOT_FOUND
      ) {
        // A retired or unknown nsid stays a tomb: the identity is dead and
        // the expired marker keeps clients on the fallback rendering.
        throw new Error(`nsid ${nsid} is not bound at the publisher`);
      }
      throw error;
    }
  }

  private pairKey(pair: ProfileNamespacePair): string {
    return JSON.stringify([pair.publisherNamespaceId, pair.profileNamespaceId]);
  }
}
