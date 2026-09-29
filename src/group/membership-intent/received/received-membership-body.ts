import { RELATIONSHIP_INTENT_REQUEST_TTL_MS } from '../../../common/relationship-intent-state.js';

/** Only an invalid item or a missing local subject raises (permanent, mapped
 * by the consumer); every state-level input lands on a routing row. */
export class InvalidReceivedIntentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReceivedIntentError';
  }
}

export interface ReceivedIntentBodyShape {
  status: 'REQUESTED' | 'ACCEPTED' | 'REVOKED';
  profileNamespaceId: number;
  profileRev: number;
  note: string;
  requestedAt: number | null;
  expiresAt: number | null;
  messageEndSeq?: number;
  tombstoneEndSeq?: number;
}

export interface ValidatedReceivedIntentBody {
  requestedAt: Date | null;
  expiresAt: Date | null;
}

/** Wire body validation shared by the received-intent appliers:
 * positive statuses carry a consistent request/expiry pair (REQUESTED within
 * the seven-day TTL), an ACCEPTED carries timestamps and non-negative thread
 * heads, and an expired REQUESTED is a no-op (`undefined`), not an error —
 * the pull cursor still advances. */
export function validateReceivedIntentBody(
  body: ReceivedIntentBodyShape,
): ValidatedReceivedIntentBody | undefined {
  const requestedAt =
    body.requestedAt === null ? null : new Date(body.requestedAt);
  const expiresAt = body.expiresAt === null ? null : new Date(body.expiresAt);
  if (body.status === 'REQUESTED') {
    if (
      requestedAt === null ||
      expiresAt === null ||
      expiresAt <= requestedAt ||
      expiresAt.getTime() - requestedAt.getTime() >
        RELATIONSHIP_INTENT_REQUEST_TTL_MS
    )
      throw new InvalidReceivedIntentError(
        'invalid relationship request timestamps',
      );
    if (expiresAt <= new Date()) return undefined;
  } else {
    if (expiresAt !== null)
      throw new InvalidReceivedIntentError(
        'invalid relationship request timestamps',
      );
    if (
      body.status === 'ACCEPTED' &&
      (requestedAt === null ||
        !Number.isSafeInteger(body.messageEndSeq) ||
        body.messageEndSeq! < 0 ||
        !Number.isSafeInteger(body.tombstoneEndSeq) ||
        body.tombstoneEndSeq! < 0)
    )
      throw new InvalidReceivedIntentError(
        'an accepted intent requires timestamps and thread heads',
      );
  }
  return { requestedAt, expiresAt };
}
