import { describe, expect, it } from 'vitest';
import {
  assertS2SCallFrame,
  type S2SCallFrame,
} from './federated-call-protocol.js';

const signalId = 'c0a80101-0000-4000-8000-000000000001';
const validFrame = (patch: Partial<S2SCallFrame> = {}): unknown => {
  const op = patch.op ?? 'incoming';
  return {
    callSid: '550e8400-e29b-41d4-a716-446655440000',
    op,
    callType: 'AUDIO',
    ...(op === 'incoming'
      ? { payload: { fromAccount: 'alice', toAccount: 'bob' } }
      : {}),
    ...patch,
  };
};

describe('Federation v1 call frame validation', () => {
  it('accepts lifecycle, signal, connected and video upgrade shapes', () => {
    expect(() => assertS2SCallFrame(validFrame())).not.toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({
          op: 'signal',
          payload: { id: signalId, kind: 'offer', data: 'v=0' },
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
      assertS2SCallFrame(
        validFrame({ op: 'video-upgraded', callType: 'VIDEO' }),
      ),
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
            id: signalId,
            kind: 'renegotiate' as never,
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
          payload: { id: signalId, kind: 'offer', data: '😀'.repeat(32768) },
        }),
      ),
    ).not.toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({
          op: 'signal',
          payload: { id: signalId, kind: 'offer', data: '😀'.repeat(32769) },
        }),
      ),
    ).toThrow();
  });
});
