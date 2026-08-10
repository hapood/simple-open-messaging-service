import { HttpStatus } from '@nestjs/common';
import { isValidAccount } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';

export const CALL_SID_RE =
  /^([0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

const FRAME_ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const DOMAIN_RE =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/;

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

export interface FederatedCallAddress {
  account: string;
  domain: string;
}

export interface S2SCallFrame {
  id: string;
  origin: string;
  ts: number;
  from: FederatedCallAddress;
  to: FederatedCallAddress;
  callSid: string;
  op: S2SCallOp;
  callType: 'AUDIO' | 'VIDEO';
  endReason?: 'completed' | 'timeout' | 'failed';
  kind?: CallSignalKind;
  payload?: string;
  startedAt?: number;
}

const COMMON_KEYS = [
  'id',
  'origin',
  'ts',
  'from',
  'to',
  'callSid',
  'op',
  'callType',
] as const;

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

function assertAddress(
  value: unknown,
  field: string,
): asserts value is FederatedCallAddress {
  if (
    !isRecord(value) ||
    !hasExactlyKeys(value, ['account', 'domain']) ||
    typeof value.account !== 'string' ||
    !isValidAccount(value.account) ||
    typeof value.domain !== 'string' ||
    !DOMAIN_RE.test(value.domain)
  ) {
    malformed(`malformed ${field} address`);
  }
}

/** Validate the complete, closed POST /s2s/v1/call wire shape before quota or state-machine work. */
export function assertS2SCallFrame(
  value: unknown,
  localDomain: string,
): asserts value is S2SCallFrame {
  if (!isRecord(value)) malformed('call frame must be an object');

  const op = value.op;
  if (
    typeof op !== 'string' ||
    !(S2S_CALL_OPS as readonly string[]).includes(op)
  ) {
    malformed('unknown call op');
  }

  const conditionalKeys =
    op === 'signal'
      ? ['kind', 'payload']
      : op === 'connected'
        ? ['startedAt']
        : op === 'ended'
          ? ['endReason']
          : [];
  if (!hasExactlyKeys(value, [...COMMON_KEYS, ...conditionalKeys])) {
    malformed('call frame contains fields not allowed for its op');
  }

  if (
    typeof value.id !== 'string' ||
    !FRAME_ID_RE.test(value.id) ||
    typeof value.origin !== 'string' ||
    !DOMAIN_RE.test(value.origin) ||
    !isEpochMs(value.ts) ||
    typeof value.callSid !== 'string' ||
    !CALL_SID_RE.test(value.callSid) ||
    (value.callType !== 'AUDIO' && value.callType !== 'VIDEO')
  ) {
    malformed('malformed call frame scalar');
  }
  assertAddress(value.from, 'from');
  assertAddress(value.to, 'to');
  if (value.origin !== value.from.domain) {
    malformed('call origin must equal from.domain');
  }
  if (value.to.domain !== localDomain.toLowerCase().replace(/\.$/, '')) {
    malformed('call to.domain is not this server');
  }

  if (op === 'signal') {
    if (
      typeof value.kind !== 'string' ||
      !(CALL_SIGNAL_KINDS as readonly string[]).includes(value.kind) ||
      typeof value.payload !== 'string' ||
      value.payload.length === 0 ||
      value.payload.length > 32768
    ) {
      malformed('malformed call signal');
    }
  } else if (op === 'connected') {
    if (!isEpochMs(value.startedAt)) malformed('connected requires startedAt');
  } else if (op === 'ended' && value.endReason !== undefined) {
    if (
      !['completed', 'timeout', 'failed'].includes(value.endReason as string)
    ) {
      malformed('invalid call endReason');
    }
  }

  if (op === 'video-upgraded' && value.callType !== 'VIDEO') {
    malformed('video-upgraded requires callType VIDEO');
  }
}
