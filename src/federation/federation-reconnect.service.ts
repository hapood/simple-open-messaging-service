import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FederationService } from './federation.service.js';
import { FederationMissedPullService } from './federation-missed-pull.service.js';

/** 60s reconnect sweep cadence (§4.3). Module-scope so @Interval can read it at decoration time. */
const SWEEP_MS = 60_000;
/** Max stagger across domains within one tick (avoids a thundering herd on a fleet-wide outage). */
const JITTER_MS = 5000;
/** Slow poll cadence (§4.4) — pulls every trusted peer's /new-msg-map to catch a lost push. */
const SLOW_POLL_MS = 5 * 60_000;

/**
 * The 60s reconnect sweep (§4.3) — drives the self-healing the design's resilience story leans on.
 * Without it, a peer demoted by a failed signed op stays demoted until some user action happens to
 * re-trigger `ensurePeerTrusted`; this sweep makes recovery active + bounded instead.
 *
 * Each tick, pending first contacts retry their idempotent /init; demoted established peers verify the
 * pinned identity and recover through a signed ping, never a new handshake. Recovery then exchanges the
 * ephemeral discovery HWM. Old hint-map calls remain temporarily during the staged /missed cutover.
 *
 * ±jitter staggers recoveries so a fleet-wide outage doesn't hammer every peer on the same tick; the
 * inFlight guard dedupes recoveries for one domain within a sweep.
 */
@Injectable()
export class FederationReconnectService {
  private readonly logger = new Logger(FederationReconnectService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly federation: FederationService,
    private readonly missedPull: FederationMissedPullService,
  ) {}

  /** 60s reconnect sweep (§4.3). Registered with @nestjs/schedule; cleared on shutdown. */
  @Interval(SWEEP_MS)
  periodicSweep(): void {
    void this.sweep().catch((e) =>
      this.logger.warn(`reconnect sweep failed: ${(e as Error).message}`),
    );
  }

  /** Slow poll (§4.4): periodically pull every TRUSTED peer's /new-msg-map — catches a lost push that
   *  neither the debounce nor the recovery sweep surfaces (a transient push failure with no follow-up),
   *  and doubles as the one-directional fallback for trusted peers. Best-effort, fire-and-forget.
   *  Registered with @nestjs/schedule; cleared on shutdown. */
  @Interval(SLOW_POLL_MS)
  periodicSlowPoll(): void {
    void this.slowPoll().catch((e) =>
      this.logger.warn(`slow poll failed: ${(e as Error).message}`),
    );
  }

  /** Slow poll: for every TRUSTED peer, pull its /new-msg-map → our pendingPulls → drain. The inFlight
   *  guard prevents overlap with a concurrent recovery on the same domain. */
  private async slowPoll(): Promise<void> {
    const domains = await this.federation.listTrustedPeerDomains();
    for (const domain of domains) {
      if (this.inFlight.has(domain)) continue;
      this.inFlight.add(domain);
      void this.pullPeerMap(domain)
        .catch((e) =>
          this.logger.debug(`slow-pull ${domain}: ${(e as Error).message}`),
        )
        .finally(() => this.inFlight.delete(domain));
    }
  }

  private async sweep(): Promise<void> {
    const domains = await this.federation.listRecoverablePeerDomains();
    for (const domain of domains) {
      if (this.inFlight.has(domain)) continue; // a recovery for this domain is still running
      this.inFlight.add(domain);
      const jitter = Math.floor(Math.random() * JITTER_MS);
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

  /** One peer's recovery sequence. Identity is verified before any ping or data operation. Each step
   *  throws on failure (peer still down) → the caller logs and the next sweep retries. */
  private async recover(domain: string): Promise<void> {
    await this.federation.recoverPeerTrust(domain);
    await this.federation.pushDiscoveryHwm(domain);
    this.missedPull.advertise(
      domain,
      await this.federation.pullDiscoveryHwm(domain),
    );
    // Old hint transport remains during the staged cutover. It is removed once the real /missed page
    // applier is wired and the ephemeral wake-up can start that worker directly.
    await this.federation.flushDomain(domain);
    await this.pullPeerMap(domain, true);
  }

  /** Paginated pull of the peer's /new-msg-map → our pendingPulls → drain. Idempotent (originSeq dedup
   *  absorbs any overlap with a concurrent push). */
  private async pullPeerMap(
    domain: string,
    identityAlreadyVerified = false,
  ): Promise<void> {
    if (!identityAlreadyVerified) {
      await this.federation.verifyPeerIdentity(domain);
    }
    let cursor = 0;
    for (;;) {
      const page = await this.federation.pullPeerNewMsgMap(domain, cursor);
      this.federation.receiveNewMsgMapPush(domain, page.entries);
      if (page.cursor === null || !page.hasMore) break;
      cursor = page.cursor;
    }
  }
}
