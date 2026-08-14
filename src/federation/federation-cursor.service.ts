import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';
import {
  federationPullCursor,
  federationServeCursor,
} from '../database/schema.js';

export interface FederationCursorInitialization {
  localRetainedAfter: bigint;
  remoteRetainedAfter: bigint;
}

/** Allocates the message-feed head and initializes the consumer cursor.
 * Source-side ACK/last-served validation was removed from Federation v1. */
@Injectable()
export class FederationCursorService {
  constructor(private readonly database: DatabaseService) {}

  async readAllocatedThrough(peerDomain: string): Promise<bigint> {
    const [row] = await this.database.db
      .select({ allocatedThrough: federationServeCursor.allocatedThrough })
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!row) throw new Error(`peer ${peerDomain} has no message feed target`);
    return row.allocatedThrough;
  }

  async prepareLocalStart(peerDomain: string): Promise<bigint> {
    return this.database.db.transaction((tx) =>
      this.ensureTargetInTx(tx, peerDomain),
    );
  }

  async prepareHandshakeStart(peerDomain: string): Promise<bigint> {
    const [row] = await this.database.db
      .select({ allocatedThrough: federationServeCursor.allocatedThrough })
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    return row?.allocatedThrough ?? 0n;
  }

  async initializePeer(
    peerDomain: string,
    remoteRetainedAfter: bigint,
  ): Promise<FederationCursorInitialization> {
    return this.database.db.transaction((tx) =>
      this.initializePeerInTx(tx, peerDomain, remoteRetainedAfter),
    );
  }

  async initializePeerInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
    remoteRetainedAfter: bigint,
  ): Promise<FederationCursorInitialization> {
    if (remoteRetainedAfter < 0n) throw new Error('negative remote cursor');
    const localRetainedAfter = await this.ensureTargetInTx(tx, peerDomain);
    const [existing] = await tx
      .select({ retainedAfter: federationPullCursor.retainedAfter })
      .from(federationPullCursor)
      .where(eq(federationPullCursor.peerDomain, peerDomain))
      .limit(1);
    if (!existing) {
      await tx.insert(federationPullCursor).values({
        peerDomain,
        retainedAfter: remoteRetainedAfter,
        committedThrough: remoteRetainedAfter,
      });
    }
    return {
      localRetainedAfter,
      remoteRetainedAfter: existing?.retainedAfter ?? remoteRetainedAfter,
    };
  }

  private async ensureTargetInTx(
    tx: DatabaseTransaction,
    peerDomain: string,
  ): Promise<bigint> {
    await tx
      .insert(federationServeCursor)
      .values({ peerDomain })
      .onConflictDoNothing();
    const [row] = await tx
      .select({ allocatedThrough: federationServeCursor.allocatedThrough })
      .from(federationServeCursor)
      .where(eq(federationServeCursor.peerDomain, peerDomain))
      .limit(1);
    if (!row) throw new Error(`peer ${peerDomain} has no message feed target`);
    return 0n;
  }
}
