import { Injectable } from '@nestjs/common';
import {
  FederationNamespaceService,
  type FederationContext,
} from './federation-namespace.service.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { FederationTrustedPeerClient } from './federation-trusted-peer-client.service.js';

export interface FederationThreadResourceResponse<T> {
  data: T;
  threadId: number;
  peerDomain: string;
  peerToken: FederationContext;
}

/** Fetches a thread resource with the identity and authorization gates needed to persist it safely. */
@Injectable()
export class FederationThreadResourceClient {
  constructor(
    private readonly trustedPeers: FederationTrustedPeerClient,
    private readonly threadAccess: FederationThreadAccessService,
    private readonly namespaces: FederationNamespaceService,
  ) {}

  async fetch<T>(
    threadId: number,
    path: string,
    namespaceId: number,
    signal: AbortSignal,
    maxResponseBytes?: number,
  ): Promise<FederationThreadResourceResponse<T>> {
    signal.throwIfAborted();
    const peerToken = await this.namespaces.captureActiveById(namespaceId);
    signal.throwIfAborted();
    await this.threadAccess.assertThreadExists(threadId, peerToken.domain);
    const data = await this.trustedPeers.get<T>(
      path,
      peerToken.domain,
      maxResponseBytes,
      signal,
    );
    signal.throwIfAborted();
    return { data, threadId, peerDomain: peerToken.domain, peerToken };
  }
}
