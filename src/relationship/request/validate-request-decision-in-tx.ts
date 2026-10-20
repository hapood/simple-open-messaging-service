import { and, eq } from 'drizzle-orm';
import type { DatabaseTransaction } from '../../database/database.service.js';
import {
  relationshipIntent,
  relationshipRequest,
} from '../../database/schema.js';
import type { RequestFlow } from './request-transaction.contract.js';

/** Admission only, after the owner acquires its pair/business locks. A request
 * record is not relationship authority: both the exact round and its linked
 * REQUESTED intent must still be live. No locks, writes or effects are hidden
 * here; the owner applies the transition and concludes the round in this tx. */
export async function validateRequestDecisionInTx(
  tx: DatabaseTransaction,
  input: {
    flow: RequestFlow;
    requestId: bigint;
    pairActive: boolean;
    asOf: Date;
  },
): Promise<{ status: 'STALE_REQUEST' | 'EXPIRED' } | undefined> {
  if (input.pairActive) return { status: 'STALE_REQUEST' };
  const { flow, requestId, asOf } = input;
  const [round] = await tx
    .select({
      status: relationshipRequest.status,
      expiresAt: relationshipRequest.expiresAt,
    })
    .from(relationshipRequest)
    .where(
      and(
        eq(relationshipRequest.id, requestId),
        eq(relationshipRequest.kind, flow.kind),
        eq(relationshipRequest.authorAccount, flow.author.account),
        eq(relationshipRequest.authorNamespaceId, flow.author.namespaceId),
        eq(relationshipRequest.receiverAccount, flow.receiver.account),
        eq(relationshipRequest.receiverNamespaceId, flow.receiver.namespaceId),
      ),
    );
  const [intent] = await tx
    .select({
      requestId: relationshipIntent.requestId,
      status: relationshipIntent.status,
      expiresAt: relationshipIntent.expiresAt,
    })
    .from(relationshipIntent)
    .where(
      and(
        eq(relationshipIntent.authorAccount, flow.author.account),
        eq(relationshipIntent.authorNamespaceId, flow.author.namespaceId),
        eq(relationshipIntent.receiverAccount, flow.receiver.account),
        eq(relationshipIntent.receiverNamespaceId, flow.receiver.namespaceId),
      ),
    );
  if (
    round?.status !== 'REQUESTED' ||
    intent?.status !== 'REQUESTED' ||
    intent.requestId !== requestId
  )
    return { status: 'STALE_REQUEST' };
  if (
    round.expiresAt.getTime() <= asOf.getTime() ||
    !intent.expiresAt ||
    intent.expiresAt.getTime() <= asOf.getTime()
  )
    return { status: 'EXPIRED' };
  return undefined;
}
