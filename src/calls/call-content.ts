/**
 * The CALL message content shape. A 1:1 WebRTC call's TERMINAL record is a single Message of
 * ContentType.CALL, server-authored by {@link CallsService} the moment the call reaches a terminal
 * state. The call's LIVE state (ringing / accepted) is authoritative in-memory in CallsService —
 * only the terminal outcome is persisted, as a chat bubble BOTH participants see (their shared P2P
 * thread is the conversation). There is no Call table and no separate call-history read path: the
 * normal message query/missed/fan-out machinery serves the record, and (later) federation syncs it
 * for free as an ordinary federated message.
 *
 * `callSid` is the message's `clientMessageId`: the client-generated idempotency key that also
 * addresses every signaling frame. Storing the terminal record under clientMessageId = callSid makes
 * the terminal WRITE idempotent ({@link MessageService.writeMsgToThread} dedups on clientMessageId),
 * so a retried terminal request returns the original bubble instead of creating a duplicate.
 *
 * `direction` is NOT stored here — it is derived from the Message `creator` (creator === me →
 * outgoing) on the read side, exactly like any other message.
 */

import {
  CALL_OUTCOMES,
  type CallMediaType,
  type CallMessageContent,
  type CallOutcome,
} from '../../shared/call-message-content.js';

export {
  CALL_OUTCOMES,
  parseCallMessageContent as parseCallContent,
} from '../../shared/call-message-content.js';
export type {
  CallMediaType,
  CallMessageContent as CallContent,
  CallOutcome,
} from '../../shared/call-message-content.js';

type CallContent = CallMessageContent;

/** CALL's federation projection. Caller/callee are derived from the outer P2P message. */
export interface FederatedCallContent {
  mediaType: CallMediaType;
  outcome: CallOutcome;
  startedAt?: number;
  endedAt: number;
}

/** Serialize a CALL bubble's content. The caller fills every field; `type` is pinned here. */
export function buildCallContent(c: Omit<CallContent, 'type'>): string {
  return JSON.stringify({ type: 'CALL', ...c });
}

export function buildFederatedCallContent(local: CallContent): string {
  return JSON.stringify({
    mediaType: local.callType,
    outcome: local.outcome,
    ...(local.startedAt === undefined ? {} : { startedAt: local.startedAt }),
    endedAt: local.endedAt,
  } satisfies FederatedCallContent);
}

export function parseFederatedCallContent(
  content: string,
): FederatedCallContent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const record = obj as Record<string, unknown>;
  const allowed = new Set(['mediaType', 'outcome', 'startedAt', 'endedAt']);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (
    (record['mediaType'] !== 'AUDIO' && record['mediaType'] !== 'VIDEO') ||
    typeof record['outcome'] !== 'string' ||
    !CALL_OUTCOMES.includes(record['outcome'] as CallOutcome) ||
    (record['startedAt'] !== undefined && !isFiniteMs(record['startedAt'])) ||
    (record['endedAt'] !== undefined && !isFiniteMs(record['endedAt'])) ||
    !isFiniteMs(record['endedAt']) ||
    (isFiniteMs(record['startedAt']) &&
      record['endedAt'] < record['startedAt']) ||
    (['cancelled', 'declined', 'missed', 'unreachable'].includes(
      record['outcome'],
    ) &&
      record['startedAt'] !== undefined)
  ) {
    return null;
  }
  return {
    mediaType: record['mediaType'],
    outcome: record['outcome'] as CallOutcome,
    ...(isFiniteMs(record['startedAt'])
      ? { startedAt: record['startedAt'] }
      : {}),
    endedAt: record['endedAt'] as number,
  };
}

/** A finite, non-negative number (an epoch-ms or a duration in ms). */
function isFiniteMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * The short conversation-list preview label for a CALL bubble, by terminal outcome. Mirrors the
 * one-line literals the other content types use in derivePreview ('[Photo]', '[Voice message]').
 */
export function callPreviewLabel(outcome: CallOutcome): string {
  switch (outcome) {
    case 'missed':
      return '[Missed call]';
    case 'failed':
      return '[Call failed]';
    case 'unreachable':
      return '[Call unreachable]';
    case 'declined':
      return '[Call declined]';
    case 'cancelled':
      return '[Call cancelled]';
    case 'completed':
    default:
      return '[Call]';
  }
}
