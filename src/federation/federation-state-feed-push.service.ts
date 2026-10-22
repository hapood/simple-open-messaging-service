import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  FEDERATION_STATE_FEED_PUSH,
  type FederationStateFeedPusher,
} from './federation-state-feed.events.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';

/**
 * Requests a coalesced state-feed head push for peers. Emitters address peers by
 * their lifelong namespace id; domain-addressed callers are captured to the
 * current active namespace first, so a re-bound domain still routes to the
 * pinned identity. The push scheduler consumes the event and performs the
 * signed head hint over the peer HTTP pool.
 */
@Injectable()
export class FederationStateFeedPushService
  implements FederationStateFeedPusher
{
  constructor(
    private readonly threadAccess: FederationThreadAccessService,
    private readonly events: EventEmitter2,
  ) {}

  /** Capture each domain's active namespace, then request pushes for the resolved ids. */
  async pushDomains(domains: Iterable<string>): Promise<void> {
    const namespaceIds: number[] = [];
    for (const peerDomain of new Set(domains)) {
      const context =
        await this.threadAccess.capturePeerResponseToken(peerDomain);
      namespaceIds.push(context.namespaceId);
    }
    this.pushStateFeedNamespaces(namespaceIds);
  }

  pushStateFeedNamespaces(namespaceIds: Iterable<number>): void {
    for (const namespaceId of new Set(namespaceIds))
      this.events.emit(FEDERATION_STATE_FEED_PUSH, { namespaceId });
  }
}
