import type { CallSignalKind } from './federated-call-protocol.js';

export type CallLifecycleState = 'ringing' | 'accepted' | 'connected';
export type CallParticipantRole = 'caller' | 'callee';
export type CallLifecycleOperation =
  | 'ringing'
  | 'accepted'
  | 'connected'
  | 'video-upgraded'
  | 'declined'
  | 'cancelled'
  | 'missed'
  | 'ended';

export type CallTransitionDecision = 'apply' | 'noop' | 'invalid';

/**
 * The transport-neutral SOMS call transition policy. REST and Federation have
 * different authentication, addressing and error envelopes, but must agree on
 * which lifecycle operations advance, replay, or conflict with the live state.
 *
 * `allowAcceptedCancel` is the one intentional boundary distinction: a caller
 * server that has already committed `accepted` requires its local endpoint to
 * use `ended`; a callee server must still accept an in-flight federated
 * `cancelled` to converge the accepted/cancelled race.
 */
export function decideCallTransition(
  state: CallLifecycleState,
  operation: CallLifecycleOperation,
  options: { allowAcceptedCancel?: boolean } = {},
): CallTransitionDecision {
  switch (operation) {
    case 'ringing':
      return state === 'ringing' ? 'apply' : 'noop';
    case 'accepted':
      return state === 'ringing' ? 'apply' : 'noop';
    case 'connected':
      return state === 'accepted'
        ? 'apply'
        : state === 'connected'
          ? 'noop'
          : 'invalid';
    case 'video-upgraded':
      return state === 'connected' ? 'apply' : 'invalid';
    case 'declined':
    case 'missed':
      return state === 'ringing' ? 'apply' : 'invalid';
    case 'cancelled':
      return state === 'ringing' ||
        (state === 'accepted' && options.allowAcceptedCancel)
        ? 'apply'
        : 'invalid';
    case 'ended':
      return state === 'accepted' || state === 'connected'
        ? 'apply'
        : 'invalid';
  }
}

export function isSignalAllowed(
  state: CallLifecycleState,
  senderRole: CallParticipantRole,
  kind: CallSignalKind,
): boolean {
  switch (kind) {
    case 'offer':
      return senderRole === 'caller';
    case 'answer':
      return (
        senderRole === 'callee' &&
        (state === 'accepted' || state === 'connected')
      );
    case 'ice':
      return true;
    case 'video-state':
      return state === 'connected';
  }
}

export function decideVideoUpgrade(
  state: CallLifecycleState,
  initialCallType: 'AUDIO' | 'VIDEO',
  currentCallType: 'AUDIO' | 'VIDEO',
): CallTransitionDecision {
  if (state !== 'connected') return 'invalid';
  if (currentCallType === 'AUDIO') return 'apply';
  return initialCallType === 'AUDIO' ? 'noop' : 'invalid';
}

export function isEndReasonAllowed(
  state: CallLifecycleState,
  reason: 'completed' | 'timeout' | 'failed',
): boolean {
  if (state === 'ringing') return false;
  return state === 'accepted'
    ? reason === 'timeout' || reason === 'failed'
    : reason === 'completed' || reason === 'failed';
}

export function timeoutLifecycle(
  state: Extract<CallLifecycleState, 'ringing' | 'accepted'>,
):
  | { operation: 'missed'; endReason: null }
  | { operation: 'ended'; endReason: 'timeout' } {
  return state === 'ringing'
    ? { operation: 'missed', endReason: null }
    : { operation: 'ended', endReason: 'timeout' };
}
