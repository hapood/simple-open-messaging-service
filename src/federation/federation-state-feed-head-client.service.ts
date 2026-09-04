import { Injectable } from '@nestjs/common';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';

/** Sends one ephemeral State Feed head hint. Scheduling, coalescing, and retry
 * policy belong to FederationThreadRoundSchedulerService. */
@Injectable()
export class FederationStateFeedHeadClient {
  constructor(
    private readonly threadAccess: FederationThreadAccessService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly peerHttp: FederationPeerHttp,
  ) {}

  async send(peerDomain: string): Promise<void> {
    const context =
      await this.threadAccess.capturePeerResponseToken(peerDomain);
    const stateFeedEndId = await this.stateFeed.readFeedEndId(
      context.namespaceId,
    );
    await this.peerHttp.post(
      '/s2s/v1/feed-heads',
      JSON.stringify({ stateFeedEndId: stateFeedEndId.toString() }),
      peerDomain,
    );
  }
}
