import { Injectable } from '@nestjs/common';
import { isDeepStrictEqual } from 'node:util';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';
import { clientStateFeed, user } from '../database/schema.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { DatabaseService } from '../database/database.service.js';

export interface ClientStateFeedWrite {
  userId: number;
  account: string;
  domain: string;
  eventType: 'RELATIONSHIP_INTENT';
  subjectAccount: string;
  subjectDomain: string;
  body: Record<string, unknown>;
}

/** Device-facing compacted state feed. User.threadRevision is its allocator and shared scan head. */
@Injectable()
export class ClientStateFeedService {
  async writeInTx(
    tx: DatabaseTransaction,
    write: ClientStateFeedWrite,
  ): Promise<number | null> {
    const [current] = await tx
      .select({
        body: clientStateFeed.body,
      })
      .from(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, write.userId),
          eq(clientStateFeed.account, write.account),
          eq(clientStateFeed.domain, write.domain),
          eq(clientStateFeed.eventType, write.eventType),
          eq(clientStateFeed.subjectAccount, write.subjectAccount),
          eq(clientStateFeed.subjectDomain, write.subjectDomain),
        ),
      )
      .limit(1);
    if (current && isDeepStrictEqual(current.body, write.body)) return null;
    const [owner] = await tx
      .update(user)
      .set({
        threadRevision: sql`${user.threadRevision} + 1`,
        updatedAt: new Date(),
      })
      .where(eq(user.id, write.userId))
      .returning({ revision: user.threadRevision });
    if (!owner) throw new Error('client state feed owner missing');
    await tx
      .insert(clientStateFeed)
      .values({ ...write, revision: owner.revision })
      .onConflictDoUpdate({
        target: [
          clientStateFeed.userId,
          clientStateFeed.account,
          clientStateFeed.domain,
          clientStateFeed.eventType,
          clientStateFeed.subjectAccount,
          clientStateFeed.subjectDomain,
        ],
        set: {
          revision: owner.revision,
          body: write.body,
          updatedAt: new Date(),
        },
      });
    return owner.revision;
  }

  query(userId: number, fromRevision: number, toRevision: number) {
    return this.database.db
      .select()
      .from(clientStateFeed)
      .where(
        and(
          eq(clientStateFeed.userId, userId),
          gt(clientStateFeed.revision, fromRevision),
          lte(clientStateFeed.revision, toRevision),
        ),
      )
      .orderBy(asc(clientStateFeed.revision));
  }

  constructor(private readonly database: DatabaseService) {}
}
