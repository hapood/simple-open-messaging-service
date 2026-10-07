import { sql } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../../database/database.service.js';

/** One canonical endpoint of a GROUP_MEMBER pair, in storage shape. */
export interface GroupMemberPairEndpoint {
  readonly type: 'GROUP' | 'USER';
  readonly account: string;
  /** Always 0 for side A; the remote endpoint's namespace for side B. */
  readonly namespaceId: number;
}

/** Canonical endpoint order shared by the mint and every lookup: side A is
 * always the local endpoint; a local group and local member order endpoints
 * by account string so concurrent minters produce the same row. Any query for
 * a GROUP_MEMBER pair by endpoints must call this and match the returned
 * arrangement, never a hard-coded side. */
export function groupMemberPairEndpoints(input: {
  groupAccount: string;
  groupNamespaceId: number;
  memberAccount: string;
  profileNamespaceId: number;
}): [GroupMemberPairEndpoint, GroupMemberPairEndpoint] {
  const groupLocal = input.groupNamespaceId === 0;
  const memberLocal = input.profileNamespaceId === 0;
  if (groupLocal !== memberLocal) {
    const peerNamespaceId = groupLocal
      ? input.profileNamespaceId
      : input.groupNamespaceId;
    return groupLocal
      ? [
          {
            type: 'GROUP',
            account: input.groupAccount,
            namespaceId: 0,
          },
          {
            type: 'USER',
            account: input.memberAccount,
            namespaceId: peerNamespaceId,
          },
        ]
      : [
          {
            type: 'USER',
            account: input.memberAccount,
            namespaceId: 0,
          },
          {
            type: 'GROUP',
            account: input.groupAccount,
            namespaceId: peerNamespaceId,
          },
        ];
  }
  if (!groupLocal)
    throw new Error('a relationship pair has at most one remote endpoint');
  const groupFirst = input.groupAccount.localeCompare(input.memberAccount) < 0;
  const first: GroupMemberPairEndpoint = groupFirst
    ? { type: 'GROUP', account: input.groupAccount, namespaceId: 0 }
    : { type: 'USER', account: input.memberAccount, namespaceId: 0 };
  const second: GroupMemberPairEndpoint = groupFirst
    ? { type: 'USER', account: input.memberAccount, namespaceId: 0 }
    : { type: 'GROUP', account: input.groupAccount, namespaceId: 0 };
  return [first, second];
}

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
    profileNamespaceId: number;
  },
): Promise<bigint> {
  const [endpointA, endpointB] = groupMemberPairEndpoints(input);
  return mint(tx, input.threadId, endpointA, endpointB);
}

async function mint(
  tx: DatabaseTransaction,
  threadId: number,
  endpointA: GroupMemberPairEndpoint,
  endpointB: GroupMemberPairEndpoint,
): Promise<bigint> {
  const minted = await tx.execute<{ id: string }>(sql`
    INSERT INTO "RelationshipPair"
      (kind, "endpointAType", "endpointAAccount", "endpointBType", "endpointBAccount",
       "endpointBNamespaceId", "threadId")
    VALUES ('GROUP_MEMBER', ${endpointA.type}, ${endpointA.account},
      ${endpointB.type}, ${endpointB.account}, ${endpointB.namespaceId}, ${threadId})
    ON CONFLICT ("endpointAType", "endpointAAccount", "endpointBType", "endpointBAccount", "endpointBNamespaceId")
    DO UPDATE SET "threadId" = EXCLUDED."threadId", "updatedAt" = CURRENT_TIMESTAMP
    RETURNING id
  `);
  return BigInt(minted.rows[0]!.id);
}
