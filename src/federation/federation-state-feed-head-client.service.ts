import { Injectable } from '@nestjs/common';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { ProfileNamespaceFeedService } from './profile-namespace-feed.service.js';

/** Sends one ephemeral merged feed-head hint. Scheduling, coalescing, and
 * retry policy belong to FederationThreadRoundSchedulerService. */
@Injectable()
export class FederationStateFeedHeadClient {
  constructor(
    private readonly threadAccess: FederationThreadAccessService,
    private readonly stateFeed: PeerStateFeedService,
    private readonly profileNamespaceFeed: ProfileNamespaceFeedService,
    private readonly peerHttp: FederationPeerHttp,
  ) {}

  async send(peerDomain: string): Promise<void> {
    const context =
      await this.threadAccess.capturePeerResponseToken(peerDomain);
    const [stateFeedEndId, profileNamespaceFeedEndId] = await Promise.all([
      this.stateFeed.readFeedEndId(context.namespaceId),
      this.profileNamespaceFeed.readFeedEndId(),
    ]);
    await this.peerHttp.post(
      '/s2s/v1/feed-heads',
      JSON.stringify({
        stateFeedEndId: stateFeedEndId.toString(),
        profileNamespaceFeedEndId: profileNamespaceFeedEndId.toString(),
      }),
      peerDomain,
    );
  }
}
