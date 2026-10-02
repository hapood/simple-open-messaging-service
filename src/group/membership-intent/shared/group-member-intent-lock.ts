import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../database/database.service.js';

/** Row-locks both directions' intent rows of a GROUP_MEMBER pair under the
 * business locks, in coordinate order (the address is symmetric, so the lock
 * order is identical on both servers). No row exists yet while a pair is being
 * minted; the caller's insert then takes any conflicting insert lock. */
export async function lockGroupMemberIntentRowsInTx(
  tx: DatabaseTransaction,
  group: { account: string; namespaceId: number },
  member: { account: string; namespaceId: number },
): Promise<void> {
  await tx.execute(
    sql`SELECT 1 FROM "RelationshipIntent"
      WHERE ("authorAccount" = ${group.account} AND "authorNamespaceId" = ${group.namespaceId}
          AND "receiverAccount" = ${member.account} AND "receiverNamespaceId" = ${member.namespaceId})
        OR ("authorAccount" = ${member.account} AND "authorNamespaceId" = ${member.namespaceId}
          AND "receiverAccount" = ${group.account} AND "receiverNamespaceId" = ${group.namespaceId})
      ORDER BY "authorAccount", "authorNamespaceId", "receiverAccount", "receiverNamespaceId"
      FOR NO KEY UPDATE`,
  );
}
