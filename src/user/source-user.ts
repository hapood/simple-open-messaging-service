import { and, eq, sql } from 'drizzle-orm';
import { normalizeAccount } from '../common/account.js';
import type { DatabaseTransaction } from '../database/database.service.js';
import { user } from '../database/schema.js';

export interface SourceUserProfile {
  account: string;
  domain: string;
  sourceDomain: string;
  namespaceId: number;
  name: string;
  avatar?: string | null;
  bio?: string;
  profileRev: number;
  availability?: 'AVAILABLE' | 'REMOVED';
}

/** Upsert one publisher-scoped user profile without normalizing a feed-provided domain to `local`. */
export async function upsertSourceUserInTx(
  tx: DatabaseTransaction,
  profile: SourceUserProfile,
): Promise<number> {
  const account = normalizeAccount(profile.account);
  const availability = profile.availability ?? 'AVAILABLE';
  const [written] = await tx
    .insert(user)
    .values({
      account,
      domain: profile.domain,
      sourceDomain: profile.sourceDomain,
      namespaceId: profile.namespaceId,
      name: profile.name,
      avatar: profile.avatar ?? '',
      bio: profile.bio ?? '',
      profileRev: profile.profileRev,
      availability,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        user.account,
        user.domain,
        user.sourceDomain,
        user.namespaceId,
      ],
      set: {
        name: profile.name,
        avatar: profile.avatar ?? '',
        bio: profile.bio ?? '',
        profileRev: profile.profileRev,
        availability,
        updatedAt: new Date(),
      },
      setWhere: sql`${profile.profileRev} >= ${user.profileRev}`,
    })
    .returning({ id: user.id });
  if (written) return written.id;

  const existing = await tx.query.user.findFirst({
    where: and(
      eq(user.account, account),
      eq(user.domain, profile.domain),
      eq(user.sourceDomain, profile.sourceDomain),
      eq(user.namespaceId, profile.namespaceId),
    ),
    columns: { id: true },
  });
  if (!existing) throw new Error('source-scoped user upsert disappeared');
  return existing.id;
}
