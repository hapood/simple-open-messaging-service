import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../database/database.service.js';

/** Lock-preamble mint of the canonical GROUP_MEMBER pair (the conflicting
 * DO UPDATE always takes the row lock, so no separate pair select follows).
 * The two endpoint namespaces fold to one shared federation namespace — the
 * same canonical key every group-relationship mutation locks. */
export async function mintGroupMemberPairInTx(
  tx: DatabaseTransaction,
  input: {
    threadId: number;
    groupAccount: string;
    groupDomain: string;
    memberAccount: string;
    memberDomain: string;
    /** The shared federation namespace both endpoint rows carry. */
    namespaceId: number;
  },
): Promise<bigint> {
  const minted = await tx.execute<{ id: string }>(sql`
    INSERT INTO "RelationshipPair"
      (kind, "endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
       "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId", "threadId")
    VALUES ('GROUP_MEMBER', 'GROUP', ${input.groupAccount}, ${input.groupDomain},
      ${input.namespaceId}, 'USER', ${input.memberAccount}, ${input.memberDomain},
      ${input.namespaceId}, ${input.threadId})
    ON CONFLICT ("endpointAType", "endpointAAccount", "endpointADomain", "endpointANamespaceId",
      "endpointBType", "endpointBAccount", "endpointBDomain", "endpointBNamespaceId")
    DO UPDATE SET "threadId" = EXCLUDED."threadId", "updatedAt" = CURRENT_TIMESTAMP
    RETURNING id
  `);
  return BigInt(minted.rows[0]!.id);
}
