import { describe, expect, it } from 'vitest';
import {
  decideCallTransition,
  decideVideoUpgrade,
  isEndReasonAllowed,
  isSignalAllowed,
  timeoutLifecycle,
  type CallLifecycleState,
} from './call-state-machine.js';

describe('call state-machine policy', () => {
  it.each([
    ['ringing', 'accepted', 'apply'],
    ['accepted', 'accepted', 'noop'],
    ['connected', 'accepted', 'noop'],
    ['accepted', 'connected', 'apply'],
    ['connected', 'connected', 'noop'],
    ['ringing', 'connected', 'invalid'],
    ['ringing', 'declined', 'apply'],
    ['accepted', 'declined', 'invalid'],
    ['ringing', 'ended', 'apply'],
    ['accepted', 'ended', 'apply'],
    ['connected', 'ended', 'apply'],
  ] as const)('%s + %s → %s', (state, operation, expected) => {
    expect(decideCallTransition(state, operation)).toBe(expected);
  });

  it('allows accepted/cancelled convergence only at the callee-server boundary', () => {
    expect(decideCallTransition('accepted', 'cancelled')).toBe('invalid');
    expect(
      decideCallTransition('accepted', 'cancelled', {
        allowAcceptedCancel: true,
      }),
    ).toBe('apply');
  });

  it.each([
    ['ringing', 'caller', 'offer', true],
    ['ringing', 'callee', 'offer', false],
    ['ringing', 'callee', 'answer', false],
    ['accepted', 'callee', 'answer', true],
    ['connected', 'caller', 'video-state', true],
    ['accepted', 'caller', 'video-state', false],
    ['ringing', 'callee', 'ice', true],
  ] as const)('signal %s/%s/%s allowed=%s', (state, role, kind, expected) => {
    expect(isSignalAllowed(state, role, kind)).toBe(expected);
  });

  it.each([
    ['ringing', 'completed', false],
    ['ringing', 'timeout', false],
    ['ringing', 'failed', true],
    ['accepted', 'completed', true],
    ['accepted', 'timeout', true],
    ['accepted', 'failed', true],
    ['connected', 'completed', true],
    ['connected', 'timeout', false],
    ['connected', 'failed', true],
  ] as const)('end reason %s/%s allowed=%s', (state, reason, expected) => {
    expect(isEndReasonAllowed(state, reason)).toBe(expected);
  });

  it('shares timeout mapping across transports', () => {
    expect(timeoutLifecycle('ringing')).toEqual({
      operation: 'missed',
      endReason: null,
    });
    expect(timeoutLifecycle('accepted')).toEqual({
      operation: 'ended',
      endReason: 'timeout',
    });
  });

  it('distinguishes a replayed AUDIO upgrade from an invalid initial VIDEO upgrade', () => {
    expect(decideVideoUpgrade('connected', 'AUDIO', 'AUDIO')).toBe('apply');
    expect(decideVideoUpgrade('connected', 'AUDIO', 'VIDEO')).toBe('noop');
    expect(decideVideoUpgrade('connected', 'VIDEO', 'VIDEO')).toBe('invalid');
    expect(decideVideoUpgrade('accepted', 'AUDIO', 'AUDIO')).toBe('invalid');
  });

  it('covers every live state without transport-specific state names', () => {
    const states: CallLifecycleState[] = ['ringing', 'accepted', 'connected'];
    expect(
      states.every((state) => decideCallTransition(state, 'ringing')),
    ).toBe(true);
  });
});
