import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service.js';
import { findPostgresError } from '../database/database-error.js';
import { FederationCursorService } from './federation-cursor.service.js';
import {
  FederationIdentityService,
  type FederationIdentityClaim,
} from './federation-identity.service.js';
import { PeerStateFeedService } from './peer-state-feed.service.js';
import { peerStateFeedPullCursor } from '../database/schema.js';

/** Atomically commits every durable database effect of the one-time /init exchange. */
@Injectable()
export class FederationIgniteService {
  constructor(
    private readonly database: DatabaseService,
    private readonly identity: FederationIdentityService,
    private readonly cursor: FederationCursorService,
    private readonly stateFeed: PeerStateFeedService,
  ) {}

  async accept(params: {
    domain: string;
    claim: FederationIdentityClaim;
    legacyContinuityProven: boolean;
  }): Promise<bigint> {
    let result:
      | { localStartChangeId: bigint; mismatchReason?: undefined }
      | { localStartChangeId?: undefined; mismatchReason: string };
    try {
      result = await this.database.db.transaction(async (tx) => {
        await this.identity.consumeNonceInTx(tx, params.domain, params.claim);
        const mismatchReason = await this.identity.pinOrVerifyInTx(
          tx,
          params.domain,
          params.claim,
          params.legacyContinuityProven,
        );
        if (mismatchReason) return { mismatchReason };
        const cursors = await this.cursor.initializePeerInTx(
          tx,
          params.domain,
          BigInt(params.claim.startChangeId!),
        );
        await this.stateFeed.initializePeerInTx(tx, params.domain);
        await tx
          .insert(peerStateFeedPullCursor)
          .values({ peerDomain: params.domain })
          .onConflictDoNothing();
        return { localStartChangeId: cursors.localStartChangeId };
      });
    } catch (error) {
      if (findPostgresError(error)?.constraint === 'S2SIdentityNonce_pkey') {
        this.identity.throwNonceReplay();
      }
      throw error;
    }
    if (result.mismatchReason !== undefined) {
      this.identity.throwIdentityMismatch(result.mismatchReason);
    }
    return result.localStartChangeId;
  }

  async pinResponse(params: {
    domain: string;
    claim: FederationIdentityClaim;
    legacyContinuityProven: boolean;
  }): Promise<void> {
    const mismatchReason = await this.database.db.transaction(async (tx) => {
      const mismatch = await this.identity.pinOrVerifyInTx(
        tx,
        params.domain,
        params.claim,
        params.legacyContinuityProven,
      );
      if (mismatch) return mismatch;
      await this.cursor.initializePeerInTx(
        tx,
        params.domain,
        BigInt(params.claim.startChangeId!),
      );
      await this.stateFeed.initializePeerInTx(tx, params.domain);
      await tx
        .insert(peerStateFeedPullCursor)
        .values({ peerDomain: params.domain })
        .onConflictDoNothing();
      return undefined;
    });
    if (mismatchReason) this.identity.throwIdentityMismatch(mismatchReason);
  }
}
