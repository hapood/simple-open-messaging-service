import { describe, expect, it } from 'vitest';
import {
  assertS2SCallFrame,
  parseS2SCallWireFrame,
  type S2SCallFrame,
  toS2SCallWireFrame,
} from './federated-call-protocol.js';

const createUntil = 1_700_000_300_000;
const signalId = 'c0a80101-0000-4000-8000-000000000001';
const validFrame = (patch: Partial<S2SCallFrame> = {}): unknown => {
  const op = patch.op ?? 'incoming';
  return {
    callSid: '550e8400-e29b-41d4-a716-446655440000',
    op,
    ...(op === 'incoming'
      ? {
          callType: 'AUDIO',
          payload: { fromAccount: 'alice', toAccount: 'bob' },
        }
      : {}),
    ...patch,
  };
};

describe('Federation v1 call frame validation', () => {
  it('maps operation at the wire boundary and rejects the legacy op field', () => {
    const internal = validFrame() as S2SCallFrame;
    const wire = toS2SCallWireFrame(internal);

    expect(wire).toEqual({
      callId: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'incoming',
      mediaType: 'AUDIO',
      payload: { callerAccount: 'alice', calleeAccount: 'bob' },
    });
    expect(parseS2SCallWireFrame(wire)).toEqual(internal);
    expect(() => parseS2SCallWireFrame(internal)).toThrow();
    expect(() =>
      parseS2SCallWireFrame({ ...wire, callSid: wire.callId }),
    ).toThrow();
    expect(() =>
      parseS2SCallWireFrame({ ...wire, callType: wire.mediaType }),
    ).toThrow();
    expect(() =>
      parseS2SCallWireFrame({
        ...wire,
        payload: { fromAccount: 'alice', toAccount: 'bob' },
      }),
    ).toThrow();
  });

  it('maps signal identifiers and types at the wire boundary', () => {
    const internal = validFrame({
      op: 'signal',
      payload: { signalId, signalType: 'offer', data: 'v=0' },
    }) as S2SCallFrame;
    const wire = toS2SCallWireFrame(internal);

    expect(wire).toEqual({
      callId: '550e8400-e29b-41d4-a716-446655440000',
      operation: 'signal',
      payload: { signalId, signalType: 'offer', data: 'v=0' },
    });
    expect(parseS2SCallWireFrame(wire)).toEqual(internal);
    expect(() =>
      parseS2SCallWireFrame({
        ...wire,
        payload: { id: signalId, signalType: 'offer', data: 'v=0' },
      }),
    ).toThrow();
    expect(() =>
      parseS2SCallWireFrame({
        ...wire,
        payload: { signalId, kind: 'offer', data: 'v=0' },
      }),
    ).toThrow();
  });

  it('accepts lifecycle, signal, connected and video upgrade shapes', () => {
    expect(() => assertS2SCallFrame(validFrame())).not.toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({
          op: 'signal',
          payload: { signalId, signalType: 'offer', data: 'v=0' },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({
          op: 'connected',
          payload: { startedAt: 1_700_000_000_001 },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertS2SCallFrame(validFrame({ op: 'video-upgraded' })),
    ).not.toThrow();
  });

  it('rejects unknown, misplaced and incomplete conditional fields', () => {
    expect(() =>
      assertS2SCallFrame({ ...(validFrame() as object), extra: true }),
    ).toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({
          op: 'signal',
          payload: {
            signalId,
            signalType: 'renegotiate' as never,
            data: 'v=0',
          },
        }),
      ),
    ).toThrow();
    expect(() => assertS2SCallFrame(validFrame({ op: 'connected' }))).toThrow();
    expect(() => assertS2SCallFrame(validFrame({ op: 'ended' }))).toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({ op: 'video-upgraded', callType: 'AUDIO' }),
      ),
    ).toThrow();
  });

  it.each([
    'accepted',
    'ringing',
    'declined',
    'cancelled',
    'missed',
    'video-upgraded',
  ] as const)(
    'round-trips payloadless %s and rejects misplaced fields',
    (op) => {
      const internal = validFrame({ op }) as S2SCallFrame;
      const wire = toS2SCallWireFrame(internal);
      expect(wire).toEqual({ callId: internal.callSid, operation: op });
      expect(parseS2SCallWireFrame(wire)).toEqual(internal);
      for (const fields of [
        { mediaType: 'AUDIO' },
        { mediaType: 'VIDEO' },
        { createUntil },
        { payload: {} },
      ]) {
        expect(() => parseS2SCallWireFrame({ ...wire, ...fields })).toThrow();
      }
    },
  );

  it.each([createUntil, undefined, -1, 1.5, '1700000300000'])(
    'rejects undeclared createUntil on incoming (%s)',
    (value) => {
      const internal = validFrame() as S2SCallFrame;
      expect(() =>
        assertS2SCallFrame({ ...internal, createUntil: value }),
      ).toThrow();
      expect(() =>
        parseS2SCallWireFrame({
          ...toS2SCallWireFrame(internal),
          createUntil: value,
        }),
      ).toThrow();
    },
  );

  it('accepts account names only and rejects embedded domain fields', () => {
    expect(() => assertS2SCallFrame(validFrame())).not.toThrow();
    expect(() =>
      assertS2SCallFrame({
        ...(validFrame() as object),
        origin: 'evil.example',
      }),
    ).toThrow();
  });

  it('accepts canonical RFC UUID versions without assigning version semantics', () => {
    expect(() => assertS2SCallFrame(validFrame())).not.toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({ callSid: '018f3f7e-7b5a-7cc2-98c4-dc0c0c07398f' }),
      ),
    ).not.toThrow();
    expect(() =>
      assertS2SCallFrame(validFrame({ callSid: '01ARZ3NDEKTSV4RRFFQ69G5FAV' })),
    ).toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({ callSid: '550E8400-E29B-41D4-A716-446655440000' }),
      ),
    ).toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({ callSid: '550e8400-e29b-01d4-a716-446655440000' }),
      ),
    ).toThrow();
  });

  it('counts signal payload length as JSON Schema Unicode code points', () => {
    expect(() =>
      assertS2SCallFrame(
        validFrame({
          op: 'signal',
          payload: {
            signalId,
            signalType: 'offer',
            data: '😀'.repeat(32768),
          },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({
          op: 'signal',
          payload: {
            signalId,
            signalType: 'offer',
            data: '😀'.repeat(32769),
          },
        }),
      ),
    ).toThrow();
  });
});
