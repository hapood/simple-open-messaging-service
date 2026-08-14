import { Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import { threadAudience } from '../database/schema.js';
import { advanceFederatedAudienceInTx } from './federation-audience.js';

export enum FederationFeedFillState {
  CAUGHT_UP = 'CAUGHT_UP',
  NEEDS_FILL = 'NEEDS_FILL',
  FILLING = 'FILLING',
  FULL = 'FULL',
}

export interface FederationFeedFillQuantumResult {
  state: FederationFeedFillState;
  work: number;
}

/** Durable indexer backed only by audience scan positions, delivery proofs and compacted rows. */
@Injectable()
export class FederationMessageFeedIndexerService {
  constructor(private readonly database: DatabaseService) {}

  async fill(peerDomain: string): Promise<FederationFeedFillState> {
    await this.database.db.transaction(async (tx) => {
      const audiences = await tx
        .select({ threadId: threadAudience.threadId })
        .from(threadAudience)
        .where(
          and(
            eq(threadAudience.targetDomain, peerDomain),
            isNull(threadAudience.localUserId),
          ),
        );
      for (const audience of audiences)
        await advanceFederatedAudienceInTx(tx, peerDomain, audience.threadId);
    });
    return FederationFeedFillState.CAUGHT_UP;
  }

  async fillQuantum(
    peerDomain: string,
    _maxWork: number,
  ): Promise<FederationFeedFillQuantumResult> {
    await this.fill(peerDomain);
    return { state: FederationFeedFillState.CAUGHT_UP, work: 1 };
  }

  async offerCommitted(
    peerDomain: string,
    _threadId: number,
    _messageSeq: number,
  ): Promise<FederationFeedFillState> {
    return this.fill(peerDomain);
  }

  state(_peerDomain: string): FederationFeedFillState {
    return FederationFeedFillState.CAUGHT_UP;
  }
}
