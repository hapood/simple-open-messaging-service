import type { BusinessCode } from './business-code.js';

/** Expected refusal from a business command. It is data, not an exception:
 * HTTP callers serialize it and durable tasks persist it as REJECTED. */
export interface BusinessRejection {
  status: 'REJECTED';
  reason:
    | 'ACTOR_NOT_FOUND'
    | 'SELF_TARGET'
    | 'TARGET_NOT_FOUND'
    | 'THREAD_NOT_FOUND'
    | 'INVALID_READ_POSITION'
    | 'PEER_UNAVAILABLE'
    | 'IDENTITY_MISMATCH'
    | 'INTENT_NOT_FOUND'
    | 'INTENT_EXPIRED'
    | 'GROUP_NOT_FOUND'
    | 'GROUP_DISSOLVED'
    | 'FORBIDDEN'
    | 'GROUP_FULL';
  code: BusinessCode;
  message: string;
}

export function rejectBusinessCommand(
  reason: BusinessRejection['reason'],
  code: BusinessCode,
  message: string,
): BusinessRejection {
  return { status: 'REJECTED', reason, code, message };
}

export function isBusinessRejection(result: {
  status: string;
}): result is BusinessRejection {
  return result.status === 'REJECTED';
}
