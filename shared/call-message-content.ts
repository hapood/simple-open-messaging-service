export type CallMediaType = 'AUDIO' | 'VIDEO';

export type CallOutcome =
  | 'completed'
  | 'cancelled'
  | 'declined'
  | 'missed'
  | 'failed'
  | 'unreachable';

export const CALL_OUTCOMES: readonly CallOutcome[] = [
  'completed',
  'cancelled',
  'declined',
  'missed',
  'failed',
  'unreachable',
];

export interface CallMessageContent {
  type: 'CALL';
  callType: CallMediaType;
  outcome: CallOutcome;
  callerId: number | null;
  calleeId: number | null;
  startedAt?: number;
  endedAt: number;
  durationMs?: number;
}

const CALL_CONTENT_FIELDS = new Set([
  'type',
  'callType',
  'outcome',
  'status',
  'callerId',
  'calleeId',
  'startedAt',
  'endedAt',
  'durationMs',
]);

function isFiniteMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function parseCallMessageContent(
  content: string,
): CallMessageContent | null {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !CALL_CONTENT_FIELDS.has(key))) {
    return null;
  }
  const { type, callType, callerId, calleeId, startedAt, endedAt, durationMs } =
    record;
  const hasOutcome = Object.hasOwn(record, 'outcome');
  const hasLegacyStatus = Object.hasOwn(record, 'status');
  if (hasOutcome === hasLegacyStatus) return null;
  const outcome = hasOutcome ? record['outcome'] : record['status'];
  if (
    type !== 'CALL' ||
    (callType !== 'AUDIO' && callType !== 'VIDEO') ||
    typeof outcome !== 'string' ||
    !CALL_OUTCOMES.includes(outcome as CallOutcome) ||
    (callerId !== null &&
      (typeof callerId !== 'number' || !Number.isInteger(callerId))) ||
    (calleeId !== null &&
      (typeof calleeId !== 'number' || !Number.isInteger(calleeId))) ||
    !isFiniteMs(endedAt) ||
    (startedAt !== undefined && !isFiniteMs(startedAt)) ||
    (durationMs !== undefined && !isFiniteMs(durationMs)) ||
    (startedAt === undefined) !== (durationMs === undefined) ||
    (isFiniteMs(startedAt) &&
      (endedAt < startedAt || durationMs !== endedAt - startedAt)) ||
    (['cancelled', 'declined', 'missed', 'unreachable'].includes(outcome) &&
      (startedAt !== undefined || durationMs !== undefined))
  ) {
    return null;
  }
  return {
    type,
    callType,
    outcome: outcome as CallOutcome,
    callerId,
    calleeId,
    ...(isFiniteMs(startedAt) ? { startedAt } : {}),
    endedAt,
    ...(isFiniteMs(durationMs) ? { durationMs } : {}),
  };
}

export function requireCallMessageContent(content: string): CallMessageContent {
  const parsed = parseCallMessageContent(content);
  if (!parsed) throw new Error('invalid CALL message content');
  return parsed;
}
