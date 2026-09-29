import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../database/database.service.js';

/** Lock-preamble mint of the canonical GROUP_MEMBER pair (the conflicting
 * DO UPDATE always takes the row lock, so no separate pair select follows).
 * Locality is judged by namespaceId === 0. Side A is always the local
 * endpoint; the pair stores the remote endpoint's namespace once as
 * endpointBNamespaceId (0 for a local group and local member). */
export async function mintGroupMemberPairInTx(
  tx: DatabaseTransaction,
  input: {
    threadId: number;
    groupAccount: string;
    /** The group's own identity namespace; 0 for a group hosted here. */
    groupNamespaceId: number;
    memberAccount: string;
    /** The member's own identity namespace; 0 for a local member. */
    memberNamespaceId: number;
  },
): Promise<bigint> {
  const groupLocal = input.groupNamespaceId === 0;
  const memberLocal = input.memberNamespaceId === 0;
  if (groupLocal !== memberLocal) {
    const local = groupLocal
      ? { type: 'GROUP', account: input.groupAccount }
      : { type: 'USER', account: input.memberAccount };
    const remote = groupLocal
      ? { type: 'USER', account: input.memberAccount }
      : { type: 'GROUP', account: input.groupAccount };
    const peerNamespaceId = groupLocal
      ? input.memberNamespaceId
      : input.groupNamespaceId;
    return mint(tx, input.threadId, local, remote, peerNamespaceId);
  }
  if (!groupLocal)
    throw new Error('a relationship pair has at most one remote endpoint');
  const [first, second] =
    input.groupAccount.localeCompare(input.memberAccount) < 0
      ? [
          { type: 'GROUP', account: input.groupAccount },
          { type: 'USER', account: input.memberAccount },
        ]
      : [
          { type: 'USER', account: input.memberAccount },
          { type: 'GROUP', account: input.groupAccount },
        ];
  return mint(tx, input.threadId, first, second, 0);
}

async function mint(
  tx: DatabaseTransaction,
  threadId: number,
  endpointA: { type: string; account: string },
  endpointB: { type: string; account: string },
  peerNamespaceId: number,
): Promise<bigint> {
  const minted = await tx.execute<{ id: string }>(sql`
    INSERT INTO "RelationshipPair"
      (kind, "endpointAType", "endpointAAccount", "endpointBType", "endpointBAccount",
       "endpointBNamespaceId", "threadId")
    VALUES ('GROUP_MEMBER', ${endpointA.type}, ${endpointA.account},
      ${endpointB.type}, ${endpointB.account}, ${peerNamespaceId}, ${threadId})
    ON CONFLICT ("endpointAType", "endpointAAccount", "endpointBType", "endpointBAccount", "endpointBNamespaceId")
    DO UPDATE SET "threadId" = EXCLUDED."threadId", "updatedAt" = CURRENT_TIMESTAMP
    RETURNING id
  `);
  return BigInt(minted.rows[0]!.id);
}
