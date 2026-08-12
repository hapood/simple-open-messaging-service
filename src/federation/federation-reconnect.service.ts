import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { FederationService } from './federation.service.js';
import { FederationMessageFeedPullService } from './federation-message-feed-pull.service.js';

/** 60s reconnect sweep cadence (§4.3). Module-scope so @Interval can read it at decoration time. */
const SWEEP_MS = 60_000;
/** Max stagger across domains within one tick (avoids a thundering herd on a fleet-wide outage). */
const JITTER_MS = 5000;
/** Durable reconciliation cadence for recognized peers; lightweight HWM reads return quickly. */
const RECONCILE_MS = 5 * 60_000;

/**
 * The 60s reconnect sweep (§4.3) — drives the self-healing the design's resilience story leans on.
 * Without it, a transport-degraded peer stays degraded until user traffic happens to retry it; this
 * sweep makes availability recovery active and bounded.
 *
 * Each tick retries missing idempotent recognition facts or probes an established pinned relationship
 * with Healthy. Recovery then exchanges ephemeral feed revisions and drains state before messages.
 *
 * ±jitter staggers recoveries so a fleet-wide outage doesn't hammer every peer on the same tick; the
 * inFlight guard dedupes recoveries for one domain within a sweep.
 */
@Injectable()
export class FederationReconnectService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FederationReconnectService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly federation: FederationService,
    private readonly missedPull: FederationMessageFeedPullService,
  ) {}

  onApplicationBootstrap(): void {
    void this.reconcileTrustedPeers().catch((error) =>
      this.logger.warn(
        `startup reconciliation failed: ${(error as Error).message}`,
      ),
    );
  }

  /** 60s reconnect sweep (§4.3). Registered with @nestjs/schedule; cleared on shutdown. */
  @Interval(SWEEP_MS)
  periodicSweep(): void {
    void this.sweep().catch((e) =>
      this.logger.warn(`reconnect sweep failed: ${(e as Error).message}`),
    );
  }

  @Interval(RECONCILE_MS)
  periodicReconciliation(): void {
    void this.reconcileTrustedPeers().catch((error) =>
      this.logger.warn(
        `recognized-peer reconciliation failed: ${(error as Error).message}`,
      ),
    );
  }

  private async reconcileTrustedPeers(): Promise<void> {
    const domains = await this.federation.listTrustedPeerDomains();
    for (const domain of domains) {
      if (this.inFlight.has(domain)) continue;
      this.inFlight.add(domain);
      void this.reconcile(domain)
        .catch((error) =>
          this.logger.debug(`reconcile ${domain}: ${(error as Error).message}`),
        )
        .finally(() => this.inFlight.delete(domain));
    }
  }

  private async reconcile(domain: string): Promise<void> {
    await this.federation.pullStateFromPeer(domain);
    await this.federation.pullMissedFromPeer(this.missedPull, domain);
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
    await this.federation.pullStateFromPeer(domain);
    await this.federation.pullMissedFromPeer(this.missedPull, domain);
  }
}
