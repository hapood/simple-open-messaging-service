import { describe, it, expect } from 'vitest';
import { FederationBufferService } from './federation-buffer.service.js';

// The outbound hint buffer is now PURE STORAGE (zero constructor deps) — the ideal unit-test target.
// These cover the invariants signalOutbound + the debounced flush rely on: latest-seq-wins, the \0
// scopeKey that keeps a leave hint distinct from a message hint, the per-domain cap's half-eviction,
// and the non-destructive snapshot / flushBatch-then-deleteKeys ack dance.
describe('FederationBufferService (pure outbound hint storage)', () => {
  const D = 'peer.com';

  it('markDirty is latest-seq-wins: newer overwrites, equal/stale never regresses', () => {
    const b = new FederationBufferService();
    b.markDirty(D, 'alice', 'soms.io', 'bob', 5);
    b.markDirty(D, 'alice', 'soms.io', 'bob', 9); // newer → overwrite
    expect(b.snapshotOutboundFor(D, 0, 100).entries[0].latestSeq).toBe(9);

    b.markDirty(D, 'alice', 'soms.io', 'bob', 7); // stale → ignored
    b.markDirty(D, 'alice', 'soms.io', 'bob', 9); // equal → ignored
    expect(b.snapshotOutboundFor(D, 0, 100).entries[0].latestSeq).toBe(9);
  });

  it('a leave hint coexists with a message hint for the same (from,to) — \\0 scopeKey keeps them distinct', () => {
    const b = new FederationBufferService();
    b.markDirty(D, 'alice', 'soms.io', '!grp', 3);
    b.markDirty(D, 'alice', 'soms.io', '!grp', 0, true); // left signal
    const entries = b.snapshotOutboundFor(D, 0, 100).entries;
    expect(entries).toHaveLength(2);
    expect(entries.filter((e) => e.left)).toHaveLength(1);
    expect(entries.filter((e) => !e.left)).toHaveLength(1);
  });

  it('distinct conversations are distinct entries (one per (from,fromDomain,to,left))', () => {
    const b = new FederationBufferService();
    b.markDirty(D, 'alice', 'soms.io', 'bob', 1);
    b.markDirty(D, 'alice', 'soms.io', 'carol', 1);
    b.markDirty(D, 'alice', 'soms.io', '!grp', 1);
    expect(b.snapshotOutboundFor(D, 0, 100).entries).toHaveLength(3);
  });

  it('snapshotOutboundFor is NON-destructive (a pull does not drop entries — only a push ack does)', () => {
    const b = new FederationBufferService();
    b.markDirty(D, 'alice', 'soms.io', 'bob', 4);
    b.snapshotOutboundFor(D, 0, 100);
    expect(b.snapshotOutboundFor(D, 0, 100).entries).toHaveLength(1);
  });

  it('snapshotOutboundFor paginates by cursor (take + hasMore + null cursor at the end)', () => {
    const b = new FederationBufferService();
    for (let i = 0; i < 5; i++) b.markDirty(D, `u${i}`, 'soms.io', 'bob', i);

    const p1 = b.snapshotOutboundFor(D, 0, 2);
    expect(p1.entries).toHaveLength(2);
    expect(p1.hasMore).toBe(true);
    expect(p1.cursor).toBe(2);

    const p2 = b.snapshotOutboundFor(D, p1.cursor as number, 2);
    expect(p2.entries).toHaveLength(2);
    expect(p2.hasMore).toBe(true);

    const p3 = b.snapshotOutboundFor(D, p2.cursor as number, 2);
    expect(p3.entries).toHaveLength(1);
    expect(p3.hasMore).toBe(false);
    expect(p3.cursor).toBeNull();
  });

  it('flushBatch returns oldest-first entries + the scopeKeys needed to ack them', () => {
    const b = new FederationBufferService();
    b.markDirty(D, 'a', 'soms.io', 'x', 1);
    b.markDirty(D, 'b', 'soms.io', 'x', 2);
    const batch = b.flushBatch(D, 1);
    expect(batch.entries).toHaveLength(1);
    expect(batch.keys).toHaveLength(1);
    expect(batch.hasMore).toBe(true);
  });

  it('deleteKeys drops only the acked entries — a FAILED push leaves the batch buffered', () => {
    const b = new FederationBufferService();
    b.markDirty(D, 'a', 'soms.io', 'x', 1);
    b.markDirty(D, 'b', 'soms.io', 'x', 2);
    const first = b.flushBatch(D, 1);
    b.deleteKeys(D, first.keys); // ack the first only
    const rest = b.flushBatch(D, 100);
    expect(rest.entries).toHaveLength(1);
    expect(rest.entries[0].from).toBe('b'); // the not-yet-acked entry survived
  });

  it('half-evicts the older half on CAP_PER_DOMAIN overflow (bounded by active-conversation count)', () => {
    const b = new FederationBufferService();
    const CAP = 10_000;
    for (let i = 0; i < CAP + 10; i++) b.markDirty(D, `u${i}`, 'soms.io', 'x', 1);
    const size = b.snapshotOutboundFor(D, 0, CAP + 100).entries.length;
    // Overflow triggered a half-eviction; size is back under the cap and kept roughly half+.
    expect(size).toBeLessThanOrEqual(CAP);
    expect(size).toBeGreaterThanOrEqual(CAP / 2);
  });

  it('dropDomainIfEmpty removes an emptied domain bucket', () => {
    const b = new FederationBufferService();
    b.markDirty(D, 'a', 'soms.io', 'x', 1);
    b.deleteKeys(D, b.flushBatch(D, 100).keys);
    b.dropDomainIfEmpty(D);
    expect(b.snapshotOutboundFor(D, 0, 100).entries).toHaveLength(0);
  });
});
