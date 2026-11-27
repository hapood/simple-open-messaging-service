import { describe, expect, it } from 'vitest';
import {
  TAIL_AUTHOR_CACHE_LIMIT,
  TailAuthorCache,
} from './tail-author-cache';

const SELF = { account: 'me', namespaceId: 0 };

describe('TailAuthorCache', () => {
  it('ignores zero heads, missing authors, and $system', () => {
    const cache = new TailAuthorCache(SELF, true);
    expect(cache.observe(0, { account: 'alice', namespaceId: 0 })).toBe(false);
    expect(cache.observe(1, undefined)).toBe(false);
    expect(cache.observe(2, { account: '$system', namespaceId: 0 })).toBe(false);
    expect(cache.project()).toEqual({
      hasPendingSelf: false,
      hasPendingPeer: false,
      primaryPeer: null,
      overlapPeers: [],
      hasOverflow: false,
    });
  });

  it('distinguishes self and peer by both account and namespaceId', () => {
    const cache = new TailAuthorCache(SELF, true);
    expect(cache.observe(10, { account: 'me', namespaceId: 0 })).toBe(true);
    expect(cache.observe(11, { account: 'me', namespaceId: 2 })).toBe(true);
    expect(cache.selfCount).toBe(1);
    expect(cache.peerCount).toBe(1);
    expect(cache.project()).toEqual({
      hasPendingSelf: true,
      hasPendingPeer: true,
      primaryPeer: { account: 'me', namespaceId: 2 },
      overlapPeers: [],
      hasOverflow: false,
    });
  });

  it('caps self at 100 and peer at 100 combined across all group members, trimming oldest seqs', () => {
    const cache = new TailAuthorCache(SELF, true);
    for (let seq = 1; seq <= 120; seq++) {
      cache.observe(seq, SELF);
      cache.observe(1000 + seq, { account: `u${seq % 7}`, namespaceId: seq % 3 });
    }
    expect(cache.selfCount).toBe(TAIL_AUTHOR_CACHE_LIMIT);
    expect(cache.peerCount).toBe(TAIL_AUTHOR_CACHE_LIMIT);
    // Oldest retained peer is seq 1021 (1001..1020 were evicted).
    expect(cache.project().primaryPeer).toEqual({
      account: `u${21 % 7}`,
      namespaceId: 21 % 3,
    });
    // Consuming evicted seqs is a no-op; consuming 1021 advances primaryPeer to 1022.
    expect(cache.consumeCoveredInterval(1000, 1020)).toBe(false);
    expect(cache.consumeCoveredInterval(1020, 1021)).toBe(true);
    expect(cache.project().primaryPeer).toEqual({
      account: `u${22 % 7}`,
      namespaceId: 22 % 3,
    });
  });

  it('selects oldest pending peer as primary and deduplicates up to 3 overlap avatars plus overflow', () => {
    const cache = new TailAuthorCache(SELF, true);
    cache.observe(50, { account: 'bob', namespaceId: 0 });
    cache.observe(40, { account: 'alice', namespaceId: 0 });
    cache.observe(55, { account: 'alice', namespaceId: 0 }); // duplicate of primary
    cache.observe(60, { account: 'bob', namespaceId: 1 }); // different namespace
    cache.observe(65, { account: 'carol', namespaceId: 0 });
    cache.observe(70, { account: 'bob', namespaceId: 0 }); // duplicate of overlap

    expect(cache.project()).toEqual({
      hasPendingSelf: false,
      hasPendingPeer: true,
      primaryPeer: { account: 'alice', namespaceId: 0 },
      overlapPeers: [
        { account: 'bob', namespaceId: 0 },
        { account: 'bob', namespaceId: 1 },
        { account: 'carol', namespaceId: 0 },
      ],
      hasOverflow: false,
    });

    cache.observe(75, { account: 'dave', namespaceId: 0 });
    expect(cache.project().hasOverflow).toBe(true);
    expect(cache.project().overlapPeers).toHaveLength(3);
  });

  it('never emits overlap avatars in P2P conversations', () => {
    const cache = new TailAuthorCache(SELF, false);
    cache.observe(10, { account: 'alice', namespaceId: 0 });
    cache.observe(11, { account: 'bob', namespaceId: 0 });
    expect(cache.project()).toEqual({
      hasPendingSelf: false,
      hasPendingPeer: true,
      primaryPeer: { account: 'alice', namespaceId: 0 },
      overlapPeers: [],
      hasOverflow: false,
    });
  });

  it('consumes interval metadata without dismissing a newer outstanding gap', () => {
    const cache = new TailAuthorCache(SELF, true);
    cache.observe(10, SELF);
    cache.observe(11, { account: 'alice', namespaceId: 0 });
    cache.observe(12, { account: 'bob', namespaceId: 0 });
    cache.observe(15, { account: 'carol', namespaceId: 0 });

    // A partial scan consumes identity metadata, not the outstanding tail end.
    expect(cache.consumeCoveredInterval(10, 12)).toBe(true);
    expect(cache.project().hasPendingPeer).toBe(true);
    expect(cache.project().primaryPeer).toEqual({
      account: 'carol',
      namespaceId: 0,
    });
    expect(cache.project().hasPendingSelf).toBe(true);

    // Covered/deleted-only scan (9, 15] consumes remaining entries.
    expect(cache.consumeCoveredInterval(9, 15)).toBe(true);
    expect(cache.project().hasPendingSelf).toBe(false);
    expect(cache.project().hasPendingPeer).toBe(false);
  });

  it('keeps dots after POST counts reach zero and dismisses only a covering scan', () => {
    const cache = new TailAuthorCache(SELF, true);
    cache.observeSending(['send'], 10);
    cache.observe(12, SELF);
    cache.observeSending([], 12);
    cache.consumeCoveredInterval(0, 11);
    expect(cache.project().hasPendingSelf).toBe(true);
    cache.consumeCoveredInterval(11, 12);
    expect(cache.project().hasPendingSelf).toBe(false);
    expect(cache.observe(12, SELF)).toBe(false);
  });

  it('covers a fetched gap while POST remains pending without reopening on count refresh', () => {
    const cache = new TailAuthorCache(SELF, true);
    cache.observe(12, SELF);
    cache.observeSending(['send'], 12);
    const generation = cache.captureGeneration();
    cache.consumeCoveredInterval(10, 12, generation);
    expect(cache.project().hasPendingSelf).toBe(false);
    cache.observeSending(['send'], 12);
    expect(cache.project().hasPendingSelf).toBe(false);
  });

  it('compares long-lived consumers with the current head, not their initial gap', () => {
    const cache = new TailAuthorCache(SELF, true);
    const generation = cache.captureGeneration();
    cache.observeSending(['first'], 10);
    cache.observe(11, SELF);
    cache.observe(15, { account: 'alice', namespaceId: 0 });
    cache.consumeCoveredInterval(10, 11, generation);
    expect(cache.project().hasPendingSelf).toBe(true);
    cache.consumeCoveredInterval(11, 15, generation);
    expect(cache.project().hasPendingSelf).toBe(false);
  });

  it('rejects invalid scans and a previous scope even for the same end', () => {
    const cache = new TailAuthorCache(SELF, true);
    const stale = cache.captureGeneration();
    cache.clear();
    cache.observe(12, SELF);
    expect(cache.consumeCoveredInterval(12, 12)).toBe(false);
    expect(cache.consumeCoveredInterval(0, NaN)).toBe(false);
    expect(cache.consumeCoveredInterval(0, 12, stale)).toBe(false);
    expect(cache.project().hasPendingSelf).toBe(true);
  });

  it('projects safely if an author correction leaves no peer metadata', () => {
    const cache = new TailAuthorCache(SELF, true);
    cache.observe(12, { account: 'alice', namespaceId: 0 });
    cache.observe(12, SELF);
    expect(cache.project()).toMatchObject({
      hasPendingPeer: true,
      primaryPeer: null,
      overlapPeers: [],
    });
  });

  it('clears all state on scope revocation', () => {
    const cache = new TailAuthorCache(SELF, true);
    cache.observe(10, SELF);
    cache.observe(11, { account: 'alice', namespaceId: 0 });
    cache.clear();
    expect(cache.selfCount).toBe(0);
    expect(cache.peerCount).toBe(0);
  });
});
