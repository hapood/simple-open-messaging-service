import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { FederationService } from './federation.service.js';

/**
 * The 60s reconnect sweep (§4.3) — drives the self-healing the design's resilience story leans on.
 * Without it, a peer demoted by a failed signed op stays demoted until some user action happens to
 * re-trigger `ensurePeerTrusted`; this sweep makes recovery active + bounded instead.
 *
 * Each tick, for every pending/demoted peer: ping (cheap, signed — reachability + mutual-key-validity)
 * → `ensurePeerTrusted` (re-handshake; re-fetches `.well-known` FRESH — never pins keys, so a cert/key
 * rotation can't permanently break us, worst case ~60s extra downtime) → flush our buffered outbound
 * hint map (a peer that was down missed the debounced pushes) → pull the peer's map (one-directional
 * fallback). A recover() that fails (peer still down) is expected + silent; the next tick retries.
 *
 * ±jitter staggers recoveries so a fleet-wide outage doesn't hammer every peer on the same tick; the
 * inFlight guard dedupes recoveries for one domain within a sweep. See docs/federation-step2-design.md §4.3.
 */
@Injectable()
export class FederationReconnectService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FederationReconnectService.name);
  private timer: NodeJS.Timeout | undefined;
  private slowTimer: NodeJS.Timeout | undefined;
  private readonly inFlight = new Set<string>();
  private static readonly SWEEP_MS = 60_000;
  /** Max stagger across domains within one tick (avoids a thundering herd on a fleet-wide outage). */
  private static readonly JITTER_MS = 5000;
  /** Slow poll cadence (§4.4) — pulls every trusted peer's /new-msg-map to catch a lost push. */
  private static readonly SLOW_POLL_MS = 5 * 60_000;

  constructor(
    private readonly federation: FederationService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.sweep().catch((e) =>
        this.logger.warn(`reconnect sweep failed: ${(e as Error).message}`),
      );
    }, FederationReconnectService.SWEEP_MS);
    // Slow poll (§4.4): periodically pull every TRUSTED peer's /new-msg-map — catches a lost push that
    // neither the debounce nor the recovery sweep surfaces (a transient push failure with no follow-up),
    // and doubles as the one-directional fallback for trusted peers. Best-effort, fire-and-forget.
    this.slowTimer = setInterval(() => {
      void this.slowPoll().catch((e) =>
        this.logger.warn(`slow poll failed: ${(e as Error).message}`),
      );
    }, FederationReconnectService.SLOW_POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.slowTimer) clearInterval(this.slowTimer);
  }

  /** Slow poll: for every TRUSTED peer, pull its /new-msg-map → our pendingPulls → drain. The inFlight
   *  guard prevents overlap with a concurrent recovery on the same domain. */
  private async slowPoll(): Promise<void> {
    const domains = await this.federation.listTrustedPeerDomains();
    for (const domain of domains) {
      if (this.inFlight.has(domain)) continue;
      this.inFlight.add(domain);
      void this.pullPeerMap(domain)
        .catch((e) => this.logger.debug(`slow-pull ${domain}: ${(e as Error).message}`))
        .finally(() => this.inFlight.delete(domain));
    }
  }

  private async sweep(): Promise<void> {
    const domains = await this.federation.listRecoverablePeerDomains();
    for (const domain of domains) {
      if (this.inFlight.has(domain)) continue; // a recovery for this domain is still running
      this.inFlight.add(domain);
      const jitter = Math.floor(Math.random() * FederationReconnectService.JITTER_MS);
      setTimeout(() => {
        void this.recover(domain)
          .catch((e) =>
            // Expected for a still-down peer — debug, not warn (the sweep retries next tick).
            this.logger.debug(`recover ${domain}: ${(e as Error).message}`),
          )
          .finally(() => this.inFlight.delete(domain));
      }, jitter);
    }
  }

  /** One peer's recovery sequence. Each step throws on failure (peer still down) → the caller logs + the
   *  next sweep retries. Order is cheap → expensive: ping before the re-handshake. */
  private async recover(domain: string): Promise<void> {
    await this.federation.pingPeer(domain);
    await this.federation.ensurePeerTrusted(domain);
    await this.federation.flushDomain(domain);
    await this.pullPeerMap(domain);
  }

  /** Paginated pull of the peer's /new-msg-map → our pendingPulls → drain. Idempotent (originSeq dedup
   *  absorbs any overlap with a concurrent push). */
  private async pullPeerMap(domain: string): Promise<void> {
    let cursor = 0;
    for (;;) {
      const page = await this.federation.pullPeerNewMsgMap(domain, cursor);
      this.federation.receiveNewMsgMapPush(domain, page.entries);
      if (page.cursor === null || !page.hasMore) break;
      cursor = page.cursor;
    }
  }
}
