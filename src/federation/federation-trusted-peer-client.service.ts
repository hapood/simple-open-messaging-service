import { Injectable } from '@nestjs/common';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';
import { FederationPeerRuntimeService } from './federation-peer-runtime.service.js';
import { S2sResponseError } from './federation-errors.js';
import { BusinessCode } from '../common/business-code.js';
import { QuotaPausedError } from '../quota/quota-runtime.js';

/** Runs peer operations behind a pure outbound-direction check. It never starts or recovers recognition. */
@Injectable()
export class FederationTrustedPeerClient {
  constructor(
    private readonly peerHttp: FederationPeerHttp,
    private readonly peerLifecycle: FederationPeerLifecycle,
    private readonly runtime: FederationPeerRuntimeService,
  ) {}

  async run<T>(domain: string, operation: () => Promise<T>): Promise<T> {
    const namespaceId = await this.peerLifecycle.checkOutboundReady(domain);
    try {
      return await operation();
    } catch (error) {
      if (error instanceof QuotaPausedError) {
        await this.runtime.enterCooldown(
          namespaceId,
          error.message,
          error.retryAfter,
        );
      } else if (
        error instanceof S2sResponseError &&
        (error.status === 429 ||
          error.code === BusinessCode.RATE_LIMITED ||
          error.code === BusinessCode.FEDERATION_QUOTA_EXCEEDED ||
          error.code === BusinessCode.FEDERATION_MESSAGE_QUERY_RATE_LIMITED ||
          error.code ===
            BusinessCode.FEDERATION_MESSAGE_QUERY_TEMPORARILY_UNAVAILABLE)
      ) {
        const data = error.data;
        const retryAfter =
          data !== null && typeof data === 'object' && !Array.isArray(data)
            ? (data as Record<string, unknown>).retryAfter
            : undefined;
        await this.runtime.enterCooldown(
          namespaceId,
          error.message,
          retryAfter,
        );
      }
      throw error;
    }
  }

  get<T>(
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.run(peerDomain, () =>
      this.peerHttp.get<T>(path, peerDomain, maxResponseBytes, signal),
    );
  }
}
