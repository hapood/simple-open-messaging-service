import { HttpStatus } from '@nestjs/common';
import { isValidAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

export const CALL_SID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const S2S_CALL_OPS = [
  'incoming',
  'accepted',
  'ringing',
  'declined',
  'cancelled',
  'ended',
  'missed',
  'signal',
  'connected',
  'video-upgraded',
] as const;

export const CALL_SIGNAL_KINDS = [
  'offer',
  'answer',
  'ice',
  'video-state',
] as const;

export type S2SCallOp = (typeof S2S_CALL_OPS)[number];
export type CallSignalKind = (typeof CALL_SIGNAL_KINDS)[number];
export type CallEndReason = 'completed' | 'timeout' | 'failed';
export type SdpText = string;
export type SerializedIceCandidate = string;
export type SerializedVideoState = string;
export type UnixEpochMilliseconds = number;
export type CallSignalPayload =
  | {
      id: string;
      kind: 'offer' | 'answer';
      data: SdpText;
    }
  | {
      id: string;
      kind: 'ice';
      data: SerializedIceCandidate;
    }
  | { id: string; kind: 'video-state'; data: SerializedVideoState };

interface S2SCallFrameBase {
  callSid: string;
  callType: 'AUDIO' | 'VIDEO';
}

type PayloadlessCallOp =
  | 'accepted'
  | 'ringing'
  | 'declined'
  | 'cancelled'
  | 'missed';

type PayloadlessCallFrame = {
  [Op in PayloadlessCallOp]: S2SCallFrameBase & { op: Op };
}[PayloadlessCallOp];

export type S2SCallFrame =
  | (S2SCallFrameBase & {
      op: 'incoming';
      payload: { fromAccount: string; toAccount: string };
    })
  | PayloadlessCallFrame
  | (S2SCallFrameBase & {
      op: 'signal';
      payload: CallSignalPayload;
    })
  | (S2SCallFrameBase & {
      op: 'connected';
      payload: { startedAt: UnixEpochMilliseconds };
    })
  | (S2SCallFrameBase & {
      op: 'video-upgraded';
      callType: 'VIDEO';
    })
  | (S2SCallFrameBase & {
      op: 'ended';
      payload: { endReason: CallEndReason };
    });

const COMMON_KEYS = ['callSid', 'op', 'callType'] as const;

function malformed(message: string): never {
  throw new BusinessException(
    BusinessCode.FEDERATION_MALFORMED,
    message,
    HttpStatus.BAD_REQUEST,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function hasExactlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isEpochMs(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Validate the complete, closed POST /s2s/v1/call wire shape before quota or state-machine work. */
export function assertS2SCallFrame(
  value: unknown,
): asserts value is S2SCallFrame {
  if (!isRecord(value)) malformed('call frame must be an object');

  const op = value.op;
  if (
    typeof op !== 'string' ||
    !(S2S_CALL_OPS as readonly string[]).includes(op)
  ) {
    malformed('unknown call op');
  }

  const conditionalKeys = ['incoming', 'signal', 'connected', 'ended'].includes(
    op,
  )
    ? ['payload']
    : [];
  if (!hasExactlyKeys(value, [...COMMON_KEYS, ...conditionalKeys])) {
    malformed('call frame contains fields not allowed for its op');
  }

  if (
    typeof value.callSid !== 'string' ||
    !CALL_SID_RE.test(value.callSid) ||
    (value.callType !== 'AUDIO' && value.callType !== 'VIDEO')
  ) {
    malformed('malformed call frame scalar');
  }

  if (op === 'incoming') {
    if (
      !isRecord(value.payload) ||
      !hasExactlyKeys(value.payload, ['fromAccount', 'toAccount']) ||
      typeof value.payload.fromAccount !== 'string' ||
      !isValidAccount(value.payload.fromAccount) ||
      typeof value.payload.toAccount !== 'string' ||
      !isValidAccount(value.payload.toAccount)
    ) {
      malformed('incoming requires valid account payload');
    }
  } else if (op === 'signal') {
    if (!isRecord(value.payload)) malformed('signal requires payload object');
    const kind = value.payload.kind;
    if (!hasExactlyKeys(value.payload, ['id', 'kind', 'data'])) {
      malformed('signal payload contains unknown fields');
    }
    const payloadLength =
      typeof value.payload.data === 'string'
        ? Array.from(value.payload.data).length
        : 0;
    if (
      typeof kind !== 'string' ||
      !(CALL_SIGNAL_KINDS as readonly string[]).includes(kind) ||
      typeof value.payload.id !== 'string' ||
      !CALL_SID_RE.test(value.payload.id) ||
      typeof value.payload.data !== 'string' ||
      payloadLength === 0 ||
      payloadLength > 32768
    ) {
      malformed('malformed call signal');
    }
  } else if (op === 'connected') {
    if (
      !isRecord(value.payload) ||
      !hasExactlyKeys(value.payload, ['startedAt']) ||
      !isEpochMs(value.payload.startedAt)
    ) {
      malformed('connected requires payload.startedAt');
    }
  } else if (op === 'ended') {
    if (
      !isRecord(value.payload) ||
      !hasExactlyKeys(value.payload, ['endReason']) ||
      typeof value.payload.endReason !== 'string' ||
      !['completed', 'timeout', 'failed'].includes(value.payload.endReason)
    ) {
      malformed('ended requires a valid payload.endReason');
    }
  }

  if (op === 'video-upgraded' && value.callType !== 'VIDEO') {
    malformed('video-upgraded requires callType VIDEO');
  }
}
