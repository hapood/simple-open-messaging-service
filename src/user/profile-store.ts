import { and, eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../database/database.service.js';
import { profileTable } from '../database/schema.js';

/** A revision is immutable within its subject and publisher namespace. */
export async function writeProfileSnapshotInTx(
  tx: DatabaseTransaction,
  snapshot: Omit<typeof profileTable.$inferInsert, 'createdAt'>,
): Promise<void> {
  const [inserted] = await tx
    .insert(profileTable)
    .values(snapshot)
    .onConflictDoNothing()
    .returning({ account: profileTable.account });
  if (inserted) return;
  const existing = await tx.query.profileTable.findFirst({
    where: and(
      eq(profileTable.account, snapshot.account),
      eq(profileTable.domain, snapshot.domain),
      eq(profileTable.namespaceId, snapshot.namespaceId),
      eq(profileTable.profileRev, snapshot.profileRev),
    ),
  });
  if (
    !existing ||
    existing.displayName !== snapshot.displayName ||
    existing.avatar !== (snapshot.avatar ?? '') ||
    existing.bio !== (snapshot.bio ?? '')
  )
    throw new Error('conflicting immutable profile revision');
}
