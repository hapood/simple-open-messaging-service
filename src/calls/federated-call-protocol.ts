import { HttpStatus } from '@nestjs/common';
import { isValidAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

export const CALL_SID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const S2S_CALL_OPERATIONS = [
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

export const CALL_SIGNAL_TYPES = [
  'offer',
  'answer',
  'ice',
  'video-state',
] as const;

export type S2SCallOperation = (typeof S2S_CALL_OPERATIONS)[number];
export type CallSignalType = (typeof CALL_SIGNAL_TYPES)[number];
export type CallEndReason = 'completed' | 'timeout' | 'failed';
export type SdpText = string;
export type SerializedIceCandidate = string;
export type SerializedVideoState = string;
export type CallSignalPayload =
  | {
      signalId: string;
      signalType: 'offer' | 'answer';
      data: SdpText;
    }
  | {
      signalId: string;
      signalType: 'ice';
      data: SerializedIceCandidate;
    }
  | {
      signalId: string;
      signalType: 'video-state';
      data: SerializedVideoState;
    };

interface S2SCallFrameBase {
  callSid: string;
}

type PayloadlessCallOperation =
  | 'accepted'
  | 'ringing'
  | 'declined'
  | 'cancelled'
  | 'missed'
  | 'connected';

type PayloadlessCallFrame = {
  [Operation in PayloadlessCallOperation]: S2SCallFrameBase & {
    op: Operation;
  };
}[PayloadlessCallOperation];

export type S2SCallFrame =
  | (S2SCallFrameBase & {
      op: 'incoming';
      callType: 'AUDIO' | 'VIDEO';
      payload: { fromAccount: string; toAccount: string };
    })
  | PayloadlessCallFrame
  | (S2SCallFrameBase & {
      op: 'signal';
      payload: CallSignalPayload;
    })
  | (S2SCallFrameBase & {
      op: 'video-upgraded';
    })
  | (S2SCallFrameBase & {
      op: 'ended';
      payload: { endReason: CallEndReason };
    });

type WithWirePayload<Payload> = Payload extends {
  fromAccount: infer CallerAccount;
  toAccount: infer CalleeAccount;
}
  ? Omit<Payload, 'fromAccount' | 'toAccount'> & {
      callerAccount: CallerAccount;
      calleeAccount: CalleeAccount;
    }
  : Payload;

type WithWireNames<Frame> = Frame extends {
  callSid: infer CallId;
  op: infer Operation;
}
  ? Omit<Frame, 'callSid' | 'op' | 'callType' | 'payload'> & {
      callId: CallId;
      operation: Operation;
    } & (Frame extends { callType: infer MediaType }
        ? { mediaType: MediaType }
        : unknown) &
      (Frame extends { payload: infer Payload }
        ? { payload: WithWirePayload<Payload> }
        : unknown)
  : never;

/** Closed Federation v1 wire representation of an internal call frame. */
export type S2SCallWireFrame = WithWireNames<S2SCallFrame>;

const COMMON_KEYS = ['callSid', 'op'] as const;

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

/** Validate the complete, closed internal call-frame shape. */
export function assertS2SCallFrame(
  value: unknown,
): asserts value is S2SCallFrame {
  if (!isRecord(value)) malformed('call frame must be an object');

  const op = value.op;
  if (
    typeof op !== 'string' ||
    !(S2S_CALL_OPERATIONS as readonly string[]).includes(op)
  ) {
    malformed('unknown call operation');
  }

  const conditionalKeys = ['incoming', 'signal', 'ended'].includes(op)
    ? ['payload']
    : [];
  if (
    !hasExactlyKeys(value, [
      ...COMMON_KEYS,
      ...conditionalKeys,
      ...(op === 'incoming' ? ['callType'] : []),
    ])
  ) {
    malformed('call frame contains fields not allowed for its operation');
  }

  if (typeof value.callSid !== 'string' || !CALL_SID_RE.test(value.callSid)) {
    malformed('malformed call frame scalar');
  }

  if (op === 'incoming') {
    if (
      (value.callType !== 'AUDIO' && value.callType !== 'VIDEO') ||
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
    const signalType = value.payload.signalType;
    if (!hasExactlyKeys(value.payload, ['signalId', 'signalType', 'data'])) {
      malformed('signal payload contains unknown fields');
    }
    const payloadLength =
      typeof value.payload.data === 'string'
        ? Array.from(value.payload.data).length
        : 0;
    if (
      typeof signalType !== 'string' ||
      !(CALL_SIGNAL_TYPES as readonly string[]).includes(signalType) ||
      typeof value.payload.signalId !== 'string' ||
      !CALL_SID_RE.test(value.payload.signalId) ||
      typeof value.payload.data !== 'string' ||
      payloadLength === 0 ||
      payloadLength > 32768
    ) {
      malformed('malformed call signal');
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
}

/** Parse the complete, closed POST /s2s/v1/call wire shape. */
export function parseS2SCallWireFrame(value: unknown): S2SCallFrame {
  if (!isRecord(value)) malformed('call frame must be an object');
  if ('op' in value) malformed('call frame contains legacy op field');
  if ('callSid' in value) malformed('call frame contains legacy callSid field');

  if ('callType' in value)
    malformed('call frame contains legacy callType field');

  const { callId, operation, mediaType, payload, ...frame } = value;
  let internalPayload = payload;
  if (operation === 'incoming' && isRecord(payload)) {
    if ('fromAccount' in payload || 'toAccount' in payload) {
      malformed('incoming payload contains legacy account fields');
    }
    const { callerAccount, calleeAccount, ...incomingPayload } = payload;
    internalPayload = {
      ...incomingPayload,
      fromAccount: callerAccount,
      toAccount: calleeAccount,
    };
  } else if (operation === 'signal' && isRecord(payload)) {
    if ('id' in payload) malformed('signal payload contains legacy id field');
    if ('kind' in payload)
      malformed('signal payload contains legacy kind field');
  }
  const internalFrame = {
    ...frame,
    ...('payload' in value ? { payload: internalPayload } : {}),
    callSid: callId,
    op: operation,
    ...('mediaType' in value ? { callType: mediaType } : {}),
  };
  assertS2SCallFrame(internalFrame);
  return internalFrame;
}

/** Serialize an internal call frame to its Federation v1 wire representation. */
export function toS2SCallWireFrame(frame: S2SCallFrame): S2SCallWireFrame {
  const { callSid, op: operation, ...conditional } = frame;
  if (frame.op === 'incoming') {
    return {
      callId: callSid,
      operation: 'incoming',
      mediaType: frame.callType,
      payload: {
        callerAccount: frame.payload.fromAccount,
        calleeAccount: frame.payload.toAccount,
      },
    };
  }
  return { callId: callSid, operation, ...conditional } as S2SCallWireFrame;
}
