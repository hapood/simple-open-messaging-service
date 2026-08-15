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

/** Media direction of a call. */
export type CallMediaType = 'AUDIO' | 'VIDEO';

/**
 * Terminal call outcomes (the persisted record). The transient `ringing` / `accepted` states live
 * only in CallsService's in-memory map and are never persisted.
 *
 *   completed   — connected, then normally hung up (startedAt + endedAt + durationMs set)
 *   cancelled   — the caller cancelled before the callee answered
 *   declined    — the callee explicitly rejected the ring
 *   missed      — ringing timed out with no answer (server-side backstop)
 *   failed      — connected (or answered) then the media leg failed (a connect/answer failure)
 *   unreachable — caller-side setup/signaling failed before the callee ever engaged (a setup failure;
 *                 the federation slice wires this trigger; same-server calls do not produce it yet)
 */
export type CallOutcome =
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'missed'
  | 'failed'
  | 'unreachable';

/** Every known terminal outcome (used by the parser's whitelist). */
export const CALL_OUTCOMES: readonly CallOutcome[] = [
  'completed',
  'cancelled',
  'declined',
  'missed',
  'failed',
  'unreachable',
];

/** The JSON stored in a CALL Message's `content` (stringified via {@link buildCallContent}). */
export interface CallContent {
  /** Literal discriminator 'CALL' (mirrors the INVITE/GROUP_INVITE card convention). */
  type: 'CALL';
  callType: CallMediaType;
  status: CallOutcome;
  callerId: number;
  calleeId: number;
  /** Connect epoch-ms (set on accept). Absent when the call never connected. */
  startedAt?: number;
  /** Terminal epoch-ms. */
  endedAt?: number;
  /** Call duration in ms (endedAt − startedAt); present iff the call connected. */
  durationMs?: number;
}

/** CALL's federation projection. Caller/callee are derived from the outer P2P message. */
export interface FederatedCallContent {
  callType: CallMediaType;
  status: CallOutcome;
  startedAt?: number;
  endedAt: number;
}

/** Serialize a CALL bubble's content. The caller fills every field; `type` is pinned here. */
export function buildCallContent(c: Omit<CallContent, 'type'>): string {
  return JSON.stringify({ type: 'CALL', ...c });
}

export function buildFederatedCallContent(local: CallContent): string {
  if (local.endedAt === undefined) {
    throw new Error('terminal CALL is missing endedAt');
  }
  return JSON.stringify({
    callType: local.callType,
    status: local.status,
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
  const allowed = new Set(['callType', 'status', 'startedAt', 'endedAt']);
  if (Object.keys(record).some((key) => !allowed.has(key))) return null;
  if (
    (record['callType'] !== 'AUDIO' && record['callType'] !== 'VIDEO') ||
    typeof record['status'] !== 'string' ||
    !CALL_OUTCOMES.includes(record['status'] as CallOutcome) ||
    (record['startedAt'] !== undefined && !isFiniteMs(record['startedAt'])) ||
    (record['endedAt'] !== undefined && !isFiniteMs(record['endedAt'])) ||
    !isFiniteMs(record['endedAt']) ||
    (isFiniteMs(record['startedAt']) &&
      record['endedAt'] < record['startedAt']) ||
    (['cancelled', 'declined', 'missed', 'unreachable'].includes(
      record['status'],
    ) &&
      record['startedAt'] !== undefined)
  ) {
    return null;
  }
  return {
    callType: record['callType'],
    status: record['status'] as CallOutcome,
    ...(isFiniteMs(record['startedAt'])
      ? { startedAt: record['startedAt'] }
      : {}),
    endedAt: record['endedAt'] as number,
  };
}

/**
 * Validate + parse a CALL message's content string. A FORM check only (mirrors parseLinkContent's
 * contract): the discriminator, callType, a whitelisted terminal status, and integer ids must be
 * present and well-typed; the optional epoch-ms/duration fields, when present, must be finite
 * non-negative numbers. Returns the typed content, or null on any shape violation. Used by the
 * conversation-list preview and any future server-side interpretation; the wire payload itself is
 * returned verbatim to clients (the client renders the bubble from this JSON).
 */
export function parseCallContent(content: string): CallContent | null {
  let obj: unknown;
  try {
    obj = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const {
    type,
    callType,
    status,
    callerId,
    calleeId,
    startedAt,
    endedAt,
    durationMs,
  } = obj as Record<string, unknown>;
  if (type !== 'CALL') return null;
  if (callType !== 'AUDIO' && callType !== 'VIDEO') return null;
  if (
    typeof status !== 'string' ||
    !CALL_OUTCOMES.includes(status as CallOutcome)
  ) {
    return null;
  }
  // typeof narrows from unknown → number; Number.isInteger then rejects non-integers.
  if (typeof callerId !== 'number' || !Number.isInteger(callerId)) return null;
  if (typeof calleeId !== 'number' || !Number.isInteger(calleeId)) return null;
  // Optional epoch-ms / duration: when present they must be finite non-negative numbers.
  if (startedAt !== undefined && !isFiniteMs(startedAt)) return null;
  if (endedAt !== undefined && !isFiniteMs(endedAt)) return null;
  if (durationMs !== undefined && !isFiniteMs(durationMs)) return null;
  if (!isFiniteMs(endedAt)) return null;
  if ((startedAt === undefined) !== (durationMs === undefined)) return null;
  if (
    isFiniteMs(startedAt) &&
    (endedAt < startedAt || durationMs !== endedAt - startedAt)
  )
    return null;
  if (
    ['cancelled', 'declined', 'missed', 'unreachable'].includes(status) &&
    (startedAt !== undefined || durationMs !== undefined)
  )
    return null;
  const out: CallContent = {
    type: 'CALL',
    callType,
    status: status as CallOutcome,
    callerId,
    calleeId,
  };
  // isFiniteMs is a type guard → narrows each field to number inside the branch.
  if (isFiniteMs(startedAt)) out.startedAt = startedAt;
  if (isFiniteMs(endedAt)) out.endedAt = endedAt;
  if (isFiniteMs(durationMs)) out.durationMs = durationMs;
  return out;
}

/** A finite, non-negative number (an epoch-ms or a duration in ms). */
function isFiniteMs(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * The short conversation-list preview label for a CALL bubble, by terminal status. Mirrors the
 * one-line literals the other content types use in derivePreview ('[Photo]', '[Voice message]').
 */
export function callPreviewLabel(status: CallOutcome): string {
  switch (status) {
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
