import { Injectable } from '@nestjs/common';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';

/** Runs peer operations behind a pure outbound-direction check. It never starts or recovers recognition. */
@Injectable()
export class FederationTrustedPeerClient {
  constructor(
    private readonly peerHttp: FederationPeerHttp,
    private readonly peerLifecycle: FederationPeerLifecycle,
  ) {}

  async run<T>(domain: string, operation: () => Promise<T>): Promise<T> {
    await this.peerLifecycle.checkOutboundReady(domain);
    return operation();
  }

  get<T>(
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
  ): Promise<T> {
    return this.run(peerDomain, () =>
      this.peerHttp.get<T>(path, peerDomain, maxResponseBytes),
    );
  }
}
