import { describe, expect, it } from 'vitest';
import {
  assertS2SCallFrame,
  type S2SCallFrame,
} from './federated-call-protocol.js';

const validFrame = (patch: Partial<S2SCallFrame> = {}): unknown => ({
  id: '01arz3ndektsv4rrffq69g5fav',
  origin: 'a.example',
  ts: 1_700_000_000_000,
  from: { account: 'alice', domain: 'a.example' },
  to: { account: 'bob', domain: 'b.example' },
  callSid: '550e8400-e29b-41d4-a716-446655440000',
  op: 'incoming',
  callType: 'AUDIO',
  ...patch,
});

describe('Federation v1 call frame validation', () => {
  it('accepts lifecycle, signal, connected and video upgrade shapes', () => {
    expect(() => assertS2SCallFrame(validFrame(), 'b.example')).not.toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({ op: 'signal', kind: 'offer', payload: 'v=0' }),
        'b.example',
      ),
    ).not.toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({ op: 'connected', startedAt: 1_700_000_000_001 }),
        'b.example',
      ),
    ).not.toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({ op: 'video-upgraded', callType: 'VIDEO' }),
        'b.example',
      ),
    ).not.toThrow();
  });

  it('rejects unknown, misplaced and incomplete conditional fields', () => {
    expect(() =>
      assertS2SCallFrame(
        { ...(validFrame() as object), extra: true },
        'b.example',
      ),
    ).toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({ op: 'signal', kind: 'renegotiate' as never }),
        'b.example',
      ),
    ).toThrow();
    expect(() =>
      assertS2SCallFrame(validFrame({ op: 'connected' }), 'b.example'),
    ).toThrow();
    expect(() =>
      assertS2SCallFrame(
        validFrame({ op: 'video-upgraded', callType: 'AUDIO' }),
        'b.example',
      ),
    ).toThrow();
  });

  it('binds origin to from.domain and recipient to the local server', () => {
    expect(() =>
      assertS2SCallFrame(validFrame({ origin: 'evil.example' }), 'b.example'),
    ).toThrow();
    expect(() => assertS2SCallFrame(validFrame(), 'c.example')).toThrow();
  });
});
