import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  federationFeedState,
  profileNamespaceFeedHead,
  peerStateFeed,
  profileNamespaceFeed,
} from '../database/schema.js';
import { FederationPeerHttp } from './federation-peer-http.js';
import { FederationThreadAccessService } from './federation-thread-access.service.js';

/** Sends one ephemeral merged feed-head hint. Scheduling, coalescing, and
 * retry policy belong to FederationStateFeedPushSchedulerService. */
@Injectable()
export class FederationStateFeedHeadClient {
  constructor(
    private readonly threadAccess: FederationThreadAccessService,
    private readonly database: DatabaseService,
    private readonly peerHttp: FederationPeerHttp,
  ) {}

  async send(peerDomain: string): Promise<void> {
    const context =
      await this.threadAccess.capturePeerResponseToken(peerDomain);
    // A single statement reads both allocators and serving-table timestamps
    // from one MVCC snapshot. IdentityNamespace.updatedAt also changes for
    // unrelated peer lifecycle work and must not timestamp feed generation.
    const result = await this.database.db.execute<{
      stateFeedEndId: string;
      profileNamespaceFeedEndId: string;
      generatedAt: number;
    }>(sql`
      SELECT
        peer."outboundStateFeedEndId"::text AS "stateFeedEndId",
        local."endId"::text AS "profileNamespaceFeedEndId",
        (extract(epoch FROM greatest(
          coalesce((SELECT max(${peerStateFeed.updatedAt})
            FROM ${peerStateFeed}
            WHERE ${peerStateFeed.namespaceId} = ${context.namespaceId}),
            'epoch'::timestamptz),
          coalesce((SELECT max(${profileNamespaceFeed.updatedAt})
            FROM ${profileNamespaceFeed}), 'epoch'::timestamptz)
        )) * 1000)::double precision AS "generatedAt"
      FROM ${federationFeedState} peer
      CROSS JOIN ${profileNamespaceFeedHead} local
      WHERE peer."namespaceId" = ${context.namespaceId} AND local.id = 0
    `);
    const snapshot = result.rows[0];
    if (!snapshot) throw new Error('feed-head namespace is missing');
    await this.peerHttp.post(
      '/s2s/v1/feed-heads',
      JSON.stringify(snapshot),
      peerDomain,
    );
  }
}
