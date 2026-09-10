import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';

/** The caller must hold the business scopes and pair lock. Deactivation
 * invalidates in-flight synchronization in the same transaction as the pair.
 * Acquire no parent locks here: callers may already hold the child thread. */
export async function setLockedP2PPairActiveInTx(
  tx: DatabaseTransaction,
  pairId: bigint,
  active: boolean,
): Promise<boolean> {
  const changed = await tx.execute<{ threadId: number | null }>(sql`
    UPDATE "RelationshipPair"
    SET active = ${active}, established = established OR ${active}, "updatedAt" = CURRENT_TIMESTAMP
    WHERE id = ${pairId} AND kind = 'P2P'
      AND active IS DISTINCT FROM ${active}
    RETURNING "threadId"
  `);
  const pair = changed.rows[0];
  if (!pair) return false;
  if (pair.threadId !== null) {
    const incremented = await tx.execute(sql`
      UPDATE "MessageThread"
      SET "authorizationEpoch" = "authorizationEpoch" + ${active ? 0 : 1},
        "federationRoundsEnabled" = ${active},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = ${pair.threadId}
      RETURNING id
    `);
    if ((incremented.rowCount ?? 0) !== 1)
      throw new Error(
        'relationship thread disappeared during activation change',
      );
  }
  return true;
}
