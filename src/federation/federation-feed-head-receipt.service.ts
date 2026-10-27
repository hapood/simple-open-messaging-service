import { Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../database/database.service.js';
import {
  federationFeedHeadReceipt,
  identityNamespace,
} from '../database/schema.js';

export interface FederationFeedHeads {
  stateFeedEndId: string;
  profileNamespaceFeedEndId: string;
  generatedAt: number;
  /** Verified HTTP signature creation time converted from seconds to milliseconds. */
  sentAt: number;
}

/** Observations are complete received snapshots, not synchronization targets. */
@Injectable()
export class FederationFeedHeadReceiptService {
  constructor(private readonly database: DatabaseService) {}

  async record(namespaceId: number, heads: FederationFeedHeads): Promise<void> {
    await this.database.db.transaction(async (tx) => {
      // Serialize even the first insert per publisher without blocking FK readers.
      // No network operations or domain transitions run while this lock is held.
      const [peer] = await tx
        .select({ id: identityNamespace.id })
        .from(identityNamespace)
        .where(eq(identityNamespace.id, namespaceId))
        .for('no key update');
      if (!peer || namespaceId <= 0)
        throw new Error('receipt publisher is missing');
      const receivedAt = new Date();
      await tx
        .insert(federationFeedHeadReceipt)
        .values({
          namespaceId,
          ...heads,
          receivedAt,
          createdAt: receivedAt,
          updatedAt: receivedAt,
        })
        .onConflictDoUpdate({
          target: federationFeedHeadReceipt.namespaceId,
          set: { ...heads, receivedAt, updatedAt: receivedAt },
        });
    });
  }
}
