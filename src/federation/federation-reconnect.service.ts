import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { Interval } from '@nestjs/schedule';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';
import { FederationStateFeedPushService } from './federation-state-feed-push.service.js';
import { FederationStatePullService } from './federation-state-pull.service.js';
import { FederationProfileNamespacePullService } from './federation-profile-namespace-pull.service.js';
import { KeypairService } from './keypair.service.js';
import {
  FEDERATION_PEER_AVAILABLE,
  type FederationPeerAvailable,
} from './federation-peer.events.js';

/** 60s reconnect sweep cadence (§4.3). Module-scope so @Interval can read it at decoration time. */
const SWEEP_MS = 60_000;
/** Max stagger across domains within one tick (avoids a thundering herd on a fleet-wide outage). */
const JITTER_MS = 5000;

/**
 * The 60s reconnect sweep retries peers still establishing acceptance. Periodic reachability
 * probing belongs to FederationHealthSchedulerService, whose bounded queue prevents slow Health
 * requests from accumulating here. After recognition recovery, this service exchanges ephemeral feed
 * revisions and drains state before messages.
 *
 * State reconciliation is event-driven: a transition to available triggers one
 * reconcile pass for that peer. Degradation refuses outbound S2S, so hints and pulls stop for the
 * whole window; recovery is when the missed state must drain.
 *
 * ±jitter staggers recoveries so a fleet-wide outage doesn't hammer every peer on the same tick; the
 * inFlight guard dedupes recoveries for one domain within a sweep.
 */
@Injectable()
export class FederationReconnectService implements OnApplicationBootstrap {
  private readonly logger = new Logger(FederationReconnectService.name);
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly peerLifecycle: FederationPeerLifecycle,
    private readonly stateFeedPush: FederationStateFeedPushService,
    private readonly statePull: FederationStatePullService,
    private readonly profileNamespacePull: FederationProfileNamespacePullService,
    private readonly events: EventEmitter2,
    private readonly keypair: KeypairService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.keypair.waitUntilInitialized();
    void this.reconcileTrustedPeers().catch((error) =>
      this.logger.warn(
        `startup reconciliation failed: ${(error as Error).message}`,
      ),
    );
  }

  /** 60s recognition-recovery sweep. Registered with @nestjs/schedule; cleared on shutdown. */
  @Interval(SWEEP_MS)
  periodicSweep(): void {
    void this.sweep().catch((e) =>
      this.logger.warn(`reconnect sweep failed: ${(e as Error).message}`),
    );
  }

  /** One reconcile pass whenever a peer becomes available. */
  @OnEvent(FEDERATION_PEER_AVAILABLE)
  onPeerAvailable(event: FederationPeerAvailable): void {
    const domain = event.peerDomain;
    if (this.inFlight.has(domain)) return;
    this.inFlight.add(domain);
    void this.reconcile(domain)
      .catch((error) =>
        this.logger.debug(`reconcile ${domain}: ${(error as Error).message}`),
      )
      .finally(() => this.inFlight.delete(domain));
  }

  private async reconcileTrustedPeers(): Promise<void> {
    const domains = await this.peerLifecycle.listTrustedPeerDomains();
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
    await this.stateFeedPush.pushDomains([domain]);
    await this.statePull.pullStateFromPeer(domain);
    // Recognition recovery also converges the Profile Namespace Feed: the
    // initial pull after a fresh handshake seeds the cursor from 0.
    await this.profileNamespacePull.pullFromPeer(domain);
  }

  private async sweep(): Promise<void> {
    const domains = await this.peerLifecycle.listRecoverablePeerDomains();
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
    await this.peerLifecycle.recoverPeerRecognition(domain);
    await this.stateFeedPush.pushDomains([domain]);
    await this.statePull.pullStateFromPeer(domain);
  }
}
