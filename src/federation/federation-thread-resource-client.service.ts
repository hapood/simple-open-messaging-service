import { Injectable } from '@nestjs/common';
import { S2sResponseError } from './federation-errors.js';
import type { FederationContext } from './federation-namespace.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';

export interface FederationThreadResourceResponse<T> {
  data: T;
  threadId: number;
  peerDomain: string;
  federationVersion: number;
  peerToken: FederationContext;
}

/** Fetches a thread resource with the identity and authorization gates needed to persist it safely. */
@Injectable()
export class FederationThreadResourceClient {
  constructor(
    private readonly trustedPeers: FederationTrustedPeerClient,
    private readonly threadAccess: FederationThreadAccessService,
  ) {}

  async read<T>(
    threadId: number,
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
  ): Promise<{ data: T; federationVersion: number }> {
    const federationVersion = await this.threadAccess.readFederationVersion(
      threadId,
      peerDomain,
    );
    try {
      const data = await this.trustedPeers.get<T>(
        path,
        peerDomain,
        maxResponseBytes,
      );
      return { data, federationVersion };
    } catch (error) {
      if (error instanceof S2sResponseError) {
        error.federationVersion = federationVersion;
      }
      throw error;
    }
  }

  async fetch<T>(
    threadId: number,
    path: string,
    peerDomain: string,
    maxResponseBytes?: number,
  ): Promise<FederationThreadResourceResponse<T>> {
    const peerToken =
      await this.threadAccess.capturePeerResponseToken(peerDomain);
    const response = await this.read<T>(
      threadId,
      path,
      peerDomain,
      maxResponseBytes,
    );
    return { ...response, threadId, peerDomain, peerToken };
  }
}
