import { Injectable } from '@nestjs/common';
import { BusinessCode } from '../common/business-code.js';
import { S2sResponseError } from './federation-errors.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationPeerLifecycle } from './federation-peer-lifecycle.js';

/** Runs peer operations behind recognition recovery while preserving transport error semantics. */
@Injectable()
export class FederationTrustedPeerClient {
  constructor(
    private readonly peerHttp: FederationPeerHttp,
    private readonly peerLifecycle: FederationPeerLifecycle,
  ) {}

  async run<T>(domain: string, operation: () => Promise<T>): Promise<T> {
    await this.peerLifecycle.ensureTrusted(domain);
    try {
      return await operation();
    } catch (error) {
      if (
        error instanceof S2sResponseError &&
        error.code === BusinessCode.FEDERATION_RECOGNITION_REQUIRED
      ) {
        await this.peerLifecycle.recoverTrust(domain);
        return operation();
      }
      throw error;
    }
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
