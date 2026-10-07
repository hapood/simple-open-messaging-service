import { TestBed } from '@angular/core/testing';
import { Subject, firstValueFrom, take } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ProfileNamespaceRepository } from './profile-namespace-store.service';
import { WebdbService } from './webdb.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import type {
  ProfileNamespaceBinding,
  ProfileNamespacePairKey,
} from './webdb-storage';

function pairKey(pair: ProfileNamespacePairKey): string {
  return `${pair.publisherNamespaceId}:${pair.profileNamespaceId}`;
}

function createFakeWebdb() {
  const rows = new Map<string, ProfileNamespaceBinding>();
  const resolveCalls: Array<{
    pairs: ProfileNamespacePairKey[];
    roundEnd: number;
  }> = [];
  let resolveImpl: (
    pairs: readonly ProfileNamespacePairKey[],
    roundEnd: number,
  ) => Promise<void> = async (pairs, roundEnd) => {
    for (const pair of pairs) {
      rows.set(pairKey(pair), {
        ...pair,
        domain: `${pair.publisherNamespaceId}-${pair.profileNamespaceId}.test`,
        rootPublicKey: 'r'.repeat(44),
        updateFeedId: roundEnd + 10,
        changeSeq: roundEnd,
        expired: false,
        status: 'ACTIVE',
        refreshedAt: Date.now(),
      });
    }
  };
  const wake = new Subject<ProfileNamespacePairKey[]>();
  return {
    rows,
    resolveCalls,
    setResolveImpl(
      impl: (
        pairs: readonly ProfileNamespacePairKey[],
        roundEnd: number,
      ) => Promise<void>,
    ) {
      resolveImpl = impl;
    },
    async getProfileNamespaceBindings(
      pairs: readonly ProfileNamespacePairKey[],
    ) {
      return pairs
        .map((p) => rows.get(pairKey(p)))
        .filter((r): r is ProfileNamespaceBinding => r !== undefined);
    },
    async resolveProfileNamespacePairs(
      pairs: readonly ProfileNamespacePairKey[],
      roundEnd: number,
    ) {
      resolveCalls.push({ pairs: [...pairs], roundEnd });
      await resolveImpl(pairs, roundEnd);
      const pending: ProfileNamespacePairKey[] = [];
      const failed: ProfileNamespacePairKey[] = [];
      const unrecoverable: ProfileNamespacePairKey[] = [];
      return { pending, failed, unrecoverable };
    },
    profileNamespaceWake$: wake.asObservable(),
    emitWake: (pairs: ProfileNamespacePairKey[]) => wake.next(pairs),
  };
}

type FakeWebdb = ReturnType<typeof createFakeWebdb>;

function setUp() {
  const webdb = createFakeWebdb();
  const ended = new Subject<void>();
  TestBed.configureTestingModule({
    providers: [
      { provide: WebdbService, useValue: webdb },
      {
        provide: SessionLifecycleService,
        useValue: { ended$: ended.asObservable() },
      },
    ],
  });
  const repo = TestBed.runInInjectionContext(
    () => new ProfileNamespaceRepository(),
  );
  return { repo, webdb, ended };
}

const PAIR_A: ProfileNamespacePairKey = {
  publisherNamespaceId: 12,
  profileNamespaceId: 0,
};
const PAIR_B: ProfileNamespacePairKey = {
  publisherNamespaceId: 13,
  profileNamespaceId: 0,
};

function seedRow(
  webdb: FakeWebdb,
  pair: ProfileNamespacePairKey,
  overrides: Partial<ProfileNamespaceBinding>,
): void {
  webdb.rows.set(pairKey(pair), {
    ...pair,
    domain: 'seed.test',
    rootPublicKey: 'r'.repeat(44),
    updateFeedId: 3,
    changeSeq: 5,
    expired: false,
    status: 'ACTIVE',
    refreshedAt: 0,
    ...overrides,
  });
}

describe('ProfileNamespaceRepository', () => {
  it('resolve emits a fresh IDB row without hitting the server', async () => {
    const { repo, webdb } = setUp();
    seedRow(webdb, PAIR_A, { domain: 'fresh.test' });
    const binding = await firstValueFrom(repo.resolve(PAIR_A));
    expect(binding).toMatchObject({ domain: 'fresh.test' });
    expect(webdb.resolveCalls.length).toBe(0);
  });

  it('resolve triggers a server round when the IDB row is missing', async () => {
    const { repo, webdb } = setUp();
    const binding = await firstValueFrom(repo.resolve(PAIR_B));
    expect(webdb.resolveCalls).toEqual([{ pairs: [PAIR_B], roundEnd: 0 }]);
    expect(binding).toMatchObject({ domain: '13-0.test', expired: false });
  });

  it('re-emits an updated binding on wake', async () => {
    const { repo, webdb } = setUp();
    seedRow(webdb, PAIR_A, { domain: 'before.test', expired: false });
    const emissions: ProfileNamespaceBinding[] = [];
    repo.resolve(PAIR_A).subscribe((b) => emissions.push(b));
    await vi.waitFor(() => expect(emissions.length).toBe(1));
    seedRow(webdb, PAIR_A, { domain: 'after.test', expired: false });
    webdb.emitWake([PAIR_A]);
    await vi.waitFor(() => expect(emissions.length).toBe(2));
    expect(emissions[1]).toMatchObject({ domain: 'after.test', expired: false });
  });

  it('guards cache writes on both coordinates', async () => {
    const { repo, webdb } = setUp();
    seedRow(webdb, PAIR_A, { changeSeq: 5, updateFeedId: 7, expired: false });
    const emissions: ProfileNamespaceBinding[] = [];
    const subscription = repo.resolve(PAIR_A).subscribe((binding) =>
      emissions.push(binding),
    );
    await vi.waitFor(() => expect(emissions.length).toBe(1));
    expect(emissions.at(-1)).toMatchObject({
      changeSeq: 5,
      updateFeedId: 7,
      expired: false,
    });

    // changeSeq regression drops.
    seedRow(webdb, PAIR_A, { changeSeq: 4, updateFeedId: 99, expired: false });
    webdb.emitWake([PAIR_A]);
    await new Promise((r) => setTimeout(r, 10));
    expect(emissions).toHaveLength(1);

    // updateFeedId regression drops.
    seedRow(webdb, PAIR_A, { changeSeq: 5, updateFeedId: 3, expired: false });
    webdb.emitWake([PAIR_A]);
    await new Promise((r) => setTimeout(r, 10));
    expect(emissions).toHaveLength(1);

    // Equal coordinates allow a display-field refresh in place.
    seedRow(webdb, PAIR_A, {
      changeSeq: 5,
      updateFeedId: 7,
      domain: 'equal.test',
    });
    webdb.emitWake([PAIR_A]);
    await vi.waitFor(() => expect(emissions.length).toBe(2));
    expect(emissions.at(-1)).toMatchObject({
      changeSeq: 5,
      updateFeedId: 7,
      domain: 'equal.test',
    });

    // changeSeq advanced, feed unchanged — lands.
    seedRow(webdb, PAIR_A, { changeSeq: 6, updateFeedId: 7, expired: false });
    webdb.emitWake([PAIR_A]);
    await vi.waitFor(() => expect(emissions.length).toBe(3));
    expect(emissions.at(-1)).toMatchObject({
      changeSeq: 6,
      expired: false,
    });
    subscription.unsubscribe();
  });

  it('bounds the LRU at 100 entries', async () => {
    const { repo, webdb } = setUp();
    for (let i = 0; i < 100; i += 1)
      seedRow(webdb, { publisherNamespaceId: i + 1, profileNamespaceId: 0 }, {});
    // Resolve 100 pairs to fill the LRU.
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        firstValueFrom(
          repo.resolve({ publisherNamespaceId: i + 1, profileNamespaceId: 0 }),
        ),
      ),
    );
    // The 101st evicts the least-recently-used (publisher 1).
    seedRow(webdb, { publisherNamespaceId: 101, profileNamespaceId: 0 }, {});
    await firstValueFrom(
      repo.resolve({ publisherNamespaceId: 101, profileNamespaceId: 0 }),
    );
    const lru = (repo as unknown as {
      lru: Map<string, ProfileNamespaceBinding>;
    }).lru;
    expect(lru.size).toBe(100);
    expect(lru.has('1:0')).toBe(false);
    expect(lru.has('101:0')).toBe(true);
  });

  it('clears the cache when the session ends', async () => {
    const { repo, webdb, ended } = setUp();
    seedRow(webdb, PAIR_A, {});
    await firstValueFrom(repo.resolve(PAIR_A));
    ended.next();
    await new Promise((r) => setTimeout(r, 0));
    // After session end the in-memory LRU is cleared; a resolve re-reads
    // IDB (row still there) so no server call fires.
    webdb.resolveCalls.length = 0;
    await firstValueFrom(repo.resolve(PAIR_A));
    expect(webdb.resolveCalls.length).toBe(0);
  });
});
