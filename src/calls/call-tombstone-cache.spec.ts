import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callTombstoneCache } from './call-tombstone-cache.js';

describe('CallTombstoneCache', () => {
  beforeEach(() => {
    callTombstoneCache.clear();
    vi.useRealTimers();
  });

  it('keeps admission atomic and scopes entries by peer domain', () => {
    expect(
      callTombstoneCache.admit({
        namespaceId: 7,
        callSid: 'call-1',
        initialCallType: 'AUDIO',
        finalCallType: 'AUDIO',
        expiresAt: Date.now() + 60_000,
        peerDomain: 'peer-a.example',
      }),
    ).toBe(true);
    expect(
      callTombstoneCache.admit({
        namespaceId: 7,
        callSid: 'call-1',
        initialCallType: 'VIDEO',
        finalCallType: 'VIDEO',
        expiresAt: Date.now() + 60_000,
        peerDomain: 'peer-b.example',
      }),
    ).toBe(false);
    expect(callTombstoneCache.get(7, 'call-1', 'peer-a.example')).toBeDefined();
    expect(
      callTombstoneCache.get(7, 'call-1', 'peer-b.example'),
    ).toBeUndefined();
  });

  it('retains the first terminal decision and signal IDs', () => {
    callTombstoneCache.admit({
      namespaceId: 7,
      callSid: 'call-1',
      initialCallType: 'AUDIO',
      finalCallType: 'AUDIO',
      expiresAt: Date.now() + 60_000,
      peerDomain: 'peer.example',
    });
    callTombstoneCache.finish({
      namespaceId: 7,
      callSid: 'call-1',
      terminalOp: 'cancelled',
      endReason: null,
      initialCallType: 'AUDIO',
      finalCallType: 'AUDIO',
      signalIds: ['signal-1'],
      expiresAt: Date.now() + 60_000,
      peerDomain: 'peer.example',
    });
    callTombstoneCache.finish({
      namespaceId: 7,
      callSid: 'call-1',
      terminalOp: 'ended',
      endReason: 'completed',
      initialCallType: 'AUDIO',
      finalCallType: 'AUDIO',
      signalIds: ['signal-2'],
      expiresAt: Date.now() + 60_000,
      peerDomain: 'peer.example',
    });

    expect(callTombstoneCache.get(7, 'call-1', 'peer.example')).toMatchObject({
      terminalOp: 'cancelled',
      signalIds: new Set(['signal-1']),
    });
  });

  it('expires entries on read and allows a new admission afterward', () => {
    vi.useFakeTimers();
    const expiresAt = Date.now() + 1_000;
    expect(
      callTombstoneCache.admit({
        namespaceId: 7,
        callSid: 'call-1',
        initialCallType: 'AUDIO',
        finalCallType: 'AUDIO',
        expiresAt,
        peerDomain: 'peer.example',
      }),
    ).toBe(true);

    vi.advanceTimersByTime(1_000);
    expect(callTombstoneCache.get(7, 'call-1', 'peer.example')).toBeUndefined();
    expect(
      callTombstoneCache.admit({
        namespaceId: 7,
        callSid: 'call-1',
        initialCallType: 'VIDEO',
        finalCallType: 'VIDEO',
        expiresAt: Date.now() + 1_000,
        peerDomain: 'peer.example',
      }),
    ).toBe(true);
  });

  it('evicts the earliest expiry when the bounded cache is full', () => {
    const expiresAt = Date.now() + 60_000;
    for (let i = 0; i < 4096; i += 1) {
      expect(
        callTombstoneCache.admit({
          namespaceId: 7,
          callSid: `call-${i}`,
          initialCallType: 'AUDIO',
          finalCallType: 'AUDIO',
          expiresAt,
          peerDomain: 'peer.example',
        }),
      ).toBe(true);
    }
    expect(
      callTombstoneCache.admit({
        namespaceId: 7,
        callSid: 'call-over-capacity',
        initialCallType: 'AUDIO',
        finalCallType: 'AUDIO',
        expiresAt,
        peerDomain: 'peer.example',
      }),
    ).toBe(true);
    expect(callTombstoneCache.get(7, 'call-0', 'peer.example')).toBeUndefined();
    expect(
      callTombstoneCache.get(7, 'call-over-capacity', 'peer.example'),
    ).toBeDefined();
  });

  it('does not let another peer domain overwrite an existing entry', () => {
    callTombstoneCache.cancelEarly({
      namespaceId: 7,
      callSid: 'call-1',
      expiresAt: Date.now() + 60_000,
      peerDomain: 'peer-a.example',
    });
    callTombstoneCache.finish({
      namespaceId: 7,
      callSid: 'call-1',
      terminalOp: 'ended',
      endReason: 'completed',
      initialCallType: 'AUDIO',
      finalCallType: 'AUDIO',
      signalIds: [],
      expiresAt: Date.now() + 60_000,
      peerDomain: 'peer-b.example',
    });

    expect(callTombstoneCache.get(7, 'call-1', 'peer-a.example')).toMatchObject(
      {
        terminalOp: 'cancelled',
      },
    );
    expect(
      callTombstoneCache.get(7, 'call-1', 'peer-b.example'),
    ).toBeUndefined();
  });
});
