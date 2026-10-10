import { isProfiledAddress, type ProfiledAddress } from './profiled-address.js';

export type CallMediaType = 'AUDIO' | 'VIDEO';
export const CALL_OUTCOMES = [
  'completed',
  'cancelled',
  'declined',
  'missed',
  'failed',
  'unreachable',
] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

export interface CallEndedContent {
  type: 'CALL_ENDED';
  callId: string;
  caller: ProfiledAddress;
  callee: ProfiledAddress;
  mediaType: CallMediaType;
  outcome: CallOutcome;
  initiatedAt: number;
  connectedAt?: number;
  endedAt: number;
}

/** Closed server-authored terminal system-message content. */
export function parseCallEndedContent(
  content: string,
): CallEndedContent | null {
  try {
    const body: unknown = JSON.parse(content);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const v = body as Record<string, unknown>;
    if (
      Object.keys(v).some(
        (k) =>
          ![
            'type',
            'callId',
            'caller',
            'callee',
            'mediaType',
            'outcome',
            'initiatedAt',
            'connectedAt',
            'endedAt',
          ].includes(k),
      )
    )
      return null;
    const time = (x: unknown): x is number =>
      Number.isSafeInteger(x) && (x as number) >= 0;
    const address = (x: unknown): ProfiledAddress | null =>
      isProfiledAddress(x) && x.account !== '$system' && x.profileRev === 0
        ? {
            account: x.account,
            profileNamespaceId: x.profileNamespaceId,
            profileRev: x.profileRev,
          }
        : null;
    const caller = address(v['caller']);
    const callee = address(v['callee']);
    if (
      v['type'] !== 'CALL_ENDED' ||
      typeof v['callId'] !== 'string' ||
      !v['callId'] ||
      !caller ||
      !callee ||
      !['AUDIO', 'VIDEO'].includes(v['mediaType'] as string) ||
      !CALL_OUTCOMES.includes(v['outcome'] as CallOutcome) ||
      !time(v['endedAt'])
    )
      return null;
    if (!time(v['initiatedAt']) || v['initiatedAt'] > v['endedAt']) return null;
    if (
      v['connectedAt'] !== undefined &&
      (!time(v['connectedAt']) ||
        v['connectedAt'] > v['endedAt'] ||
        (time(v['initiatedAt']) && v['connectedAt'] < v['initiatedAt']))
    )
      return null;
    if (v['outcome'] === 'completed' && v['connectedAt'] === undefined)
      return null;
    if (
      !['completed', 'failed'].includes(v['outcome'] as string) &&
      v['connectedAt'] !== undefined
    )
      return null;
    return {
      type: 'CALL_ENDED',
      callId: v['callId'],
      caller,
      callee,
      mediaType: v['mediaType'] as CallMediaType,
      outcome: v['outcome'] as CallOutcome,
      initiatedAt: v['initiatedAt'],
      ...(v['connectedAt'] === undefined
        ? {}
        : { connectedAt: v['connectedAt'] }),
      endedAt: v['endedAt'],
    };
  } catch {
    return null;
  }
}
