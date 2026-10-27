import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { firstValueFrom, Subject } from 'rxjs';
import {
  WebdbService,
  type ProfileSnapshot,
  type ProfileWake,
} from './webdb.service';
import type { ProfileDemand } from '../../../../shared/profile-demand';
import { ProfileRepository } from './profile-store.service';
import {
  BrowserProfileWatchEngine,
  PROFILE_WATCH_ENGINE,
} from './profile-watch.service';
import { SessionLifecycleService } from './session-lifecycle.service';
import { WebdbStorage } from './webdb-storage';

describe('Profile wake cache reads', () => {
  it('reads a prepared profile without authorizing another remote resolution', async () => {
    const storage = new WebdbStorage(() => null, new SessionLifecycleService());
    const key = {
      publisherNamespaceId: 3,
      profileNamespaceId: 5,
      account: 'alice',
      rev: 7,
    };
    const resolve = vi
      .spyOn(storage, 'resolveProfileDemand')
      .mockResolvedValue({
        status: 'READY',
        profile: {
          publisherNamespaceId: 3,
          profileNamespaceId: 5,
          account: 'alice',
          profileRev: 7,
          name: 'Alice',
          bio: '',
          avatarDigest: null,
        },
      });
    await storage.applyProfileEvent('PROFILE_AVAILABLE', key);
    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      {
        publisherNamespaceId: 3,
        lookup: 'ACCOUNT_PROFILE',
        target: { profileNamespaceId: 5, account: 'alice', rev: 7 },
      },
      { evidence: null },
    );
  });
});

describe('ProfileRepository resolution scheduler', () => {
  const profileWake = new Subject<ProfileWake>();
  const sessionEnded = new Subject<void>();
  const resolveProfileEvidence = vi.fn();
  const getProfileAvatarBlob = vi.fn();
  let repository: ProfileRepository;
  let engine: BrowserProfileWatchEngine;

  beforeEach(() => {
    resolveProfileEvidence.mockReset();
    getProfileAvatarBlob.mockReset();
    getProfileAvatarBlob.mockResolvedValue(
      new Blob(['a'], { type: 'image/webp' }),
    );
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ProfileRepository,
        {
          provide: WebdbService,
          useValue: {
            profileWake$: profileWake,
            profileNamespaceWake$: new Subject(),
            resolveProfileDemand: resolveProfileEvidence,
            getProfileAvatarBlob,
          },
        },
        {
          provide: SessionLifecycleService,
          useValue: { ended$: sessionEnded },
        },
        {
          provide: PROFILE_WATCH_ENGINE,
          useFactory: () => new BrowserProfileWatchEngine(),
        },
      ],
    });
    engine = TestBed.inject(PROFILE_WATCH_ENGINE) as BrowserProfileWatchEngine;
    repository = TestBed.inject(ProfileRepository);
  });

  it('starts only on subscription and aborts only after the last consumer leaves', () => {
    resolveProfileEvidence.mockReturnValue(new Promise(() => {}));
    const demand: ProfileDemand = {
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 1, account: 'alice', rev: 7 },
    };
    const observable = repository.resolve(demand);
    expect(resolveProfileEvidence).not.toHaveBeenCalled();
    const first = observable.subscribe();
    const second = observable.subscribe();
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(1);
    const signal = resolveProfileEvidence.mock.calls[0][1]
      .signal as AbortSignal;
    first.unsubscribe();
    expect(signal.aborted).toBe(false);
    second.unsubscribe();
    expect(signal.aborted).toBe(true);
    expect(engine['profileEntries'].size).toBe(0);
  });

  it('aborts live requests on session end', () => {
    resolveProfileEvidence.mockReturnValue(new Promise(() => {}));
    const subscription = repository
      .resolve({
        publisherNamespaceId: 0,
        lookup: 'ACCOUNT_PROFILE',
        target: { profileNamespaceId: 1, account: 'alice', rev: 7 },
      })
      .subscribe();
    const signal = resolveProfileEvidence.mock.calls[0][1]
      .signal as AbortSignal;
    sessionEnded.next();
    expect(signal.aborted).toBe(true);
    expect(subscription.closed).toBe(true);
  });

  it('an aborted request cannot delete its replacement when its rejection arrives late', async () => {
    let rejectOld!: (error: Error) => void;
    resolveProfileEvidence.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectOld = reject;
      }),
    );
    resolveProfileEvidence.mockReturnValueOnce(new Promise(() => {}));
    const demand: ProfileDemand = {
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 1, account: 'alice', rev: 7 },
    };
    const first = repository.resolve(demand).subscribe();
    const old = [...engine['profileEntries'].values()][0];
    first.unsubscribe();
    const second = repository.resolve(demand).subscribe();
    const replacement = [...engine['profileEntries'].values()][0];
    rejectOld(new Error('cancelled'));
    await vi.waitFor(() => expect(old.running).toBe(false));
    expect([...engine['profileEntries'].values()]).toEqual([replacement]);
    expect(replacement.cancellation.signal.aborted).toBe(false);
    second.unsubscribe();
  });

  it('prefetch returns immediately and shares the pending demand with rendering', async () => {
    let ready!: (value: unknown) => void;
    resolveProfileEvidence.mockReturnValue(
      new Promise((resolve) => {
        ready = resolve;
      }),
    );
    const demand: ProfileDemand = {
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 1, account: 'alice', rev: 7 },
    };
    expect(repository.prefetch(demand)).toBeUndefined();
    const rendered = firstValueFrom(repository.resolve(demand));
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(1);
    ready({
      status: 'READY',
      profile: {
        publisherNamespaceId: 0,
        profileNamespaceId: 1,
        account: 'alice',
        profileRev: 7,
        name: 'Alice',
        bio: '',
        avatarDigest: null,
      },
    });
    expect(await rendered).toMatchObject({ name: 'Alice' });
    expect(await firstValueFrom(repository.resolve(demand))).toMatchObject({
      name: 'Alice',
    });
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(1);
  });

  it('contains optional prefetch errors without failing the caller', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveProfileEvidence.mockRejectedValue(new Error('unavailable'));
      expect(
        repository.prefetch({
          publisherNamespaceId: 0,
          lookup: 'ACCOUNT_PROFILE',
          target: { profileNamespaceId: 1, account: 'alice', rev: 7 },
        }),
      ).toBeUndefined();
      await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    } finally {
      warn.mockRestore();
    }
  });

  it('reuses a committed exact profile key from the main-thread LRU', async () => {
    const snapshot: ProfileSnapshot = {
      account: 'alice',
      publisherNamespaceId: 4,
      profileNamespaceId: 4,
      profileRev: 7,
      name: 'Alice',
      avatarDigest:
        'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      bio: 'Bio',
    };
    resolveProfileEvidence.mockResolvedValue({
      status: 'READY',
      profile: snapshot,
    });
    const demand: ProfileDemand = {
      publisherNamespaceId: 4,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 4, account: 'ALICE', rev: 7 },
    };

    expect(await firstValueFrom(repository.resolve(demand))).toMatchObject({
      namespaceId: 4,
      account: 'alice',
      rev: 7,
      avatarDigest: snapshot.avatarDigest,
      avatarBlob: expect.any(Blob),
    });
    expect(await firstValueFrom(repository.resolve(demand))).toMatchObject({
      namespaceId: 4,
      rev: 7,
    });
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(1);
    expect(getProfileAvatarBlob).toHaveBeenCalledOnce();
  });

  it('serves an unevidenced lookup through the shared demand machinery', async () => {
    const demand: ProfileDemand = {
      publisherNamespaceId: 4,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 4, account: 'ALICE', rev: 7 },
    };
    resolveProfileEvidence.mockResolvedValue({
      status: 'READY',
      profile: {
        publisherNamespaceId: 4,
        profileNamespaceId: 4,
        account: 'alice',
        profileRev: 7,
        name: 'Alice',
        bio: '',
        avatarDigest: null,
      },
    });

    await expect(
      firstValueFrom(repository.resolve({ demand, evidence: null })),
    ).resolves.toMatchObject({ name: 'Alice' });
    expect(resolveProfileEvidence).toHaveBeenCalledWith(
      { ...demand, target: { ...demand.target, account: 'alice' } },
      expect.objectContaining({
        evidence: null,
        signal: expect.any(AbortSignal),
      }),
    );
    expect(engine['profileEntries'].size).toBe(0);
    // The committed READY result is cached like an authorized one: a second
    // unevidenced resolve hits the main-thread LRU without another lookup.
    await expect(
      firstValueFrom(repository.resolve({ demand, evidence: null })),
    ).resolves.toMatchObject({ name: 'Alice' });
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(1);
    profileWake.next({
      event: 'PROFILE_AVAILABLE',
      key: {
        publisherNamespaceId: 4,
        profileNamespaceId: 4,
        account: 'alice',
        rev: 7,
      },
    });
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(1);
  });

  it('attaches an unevidenced request to an in-flight evidenced resolution', async () => {
    const demand: ProfileDemand = {
      publisherNamespaceId: 4,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 4, account: 'alice', rev: 7 },
    };
    const snapshot: ProfileSnapshot = {
      account: 'alice',
      publisherNamespaceId: 4,
      profileNamespaceId: 4,
      profileRev: 7,
      name: 'Alice',
      avatarDigest: null,
      bio: '',
    };
    resolveProfileEvidence.mockImplementation(async (_demand, options) => {
      if (options?.evidence === null)
        throw new Error('profile revision is not cached');
      return {
        status: 'PENDING',
        key: { publisherNamespaceId: 4, ...demand.target },
      };
    });
    const evidenced = repository.resolve(demand).subscribe();
    const unevidenced = firstValueFrom(
      repository.resolve({ demand, evidence: null }),
    );
    // The unevidenced request dedups onto the pending authorized entry instead
    // of starting its own cache-only attempt, so no second lookup runs.
    expect(engine['profileEntries'].size).toBe(1);
    resolveProfileEvidence.mockResolvedValue({
      status: 'READY',
      profile: snapshot,
    });
    profileWake.next({
      event: 'PROFILE_AVAILABLE',
      key: {
        publisherNamespaceId: 4,
        profileNamespaceId: 4,
        account: 'alice',
        rev: 7,
      },
    });
    await expect(unevidenced).resolves.toMatchObject({ name: 'Alice' });
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(2);
    evidenced.unsubscribe();
  });

  it('does not let an unevidenced cache miss fail a later evidenced resolution', async () => {
    const demand: ProfileDemand = {
      publisherNamespaceId: 4,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 4, account: 'alice', rev: 7 },
    };
    resolveProfileEvidence.mockImplementation(async (_demand, options) => {
      if (options?.evidence === null)
        throw new Error('profile revision is not cached');
      return {
        status: 'PENDING',
        key: { publisherNamespaceId: 4, ...demand.target },
      };
    });
    await expect(
      firstValueFrom(repository.resolve({ demand, evidence: null })),
    ).rejects.toThrow('profile revision is not cached');
    // The errored cache-only entry is gone, so an authorized attempt starts
    // fresh through the evidenced strategy.
    expect(engine['profileEntries'].size).toBe(0);
    const subscription = repository.resolve(demand).subscribe();
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(2);
    expect(resolveProfileEvidence).toHaveBeenLastCalledWith(
      { ...demand, target: { ...demand.target, account: 'alice' } },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    subscription.unsubscribe();
  });

  it('keeps a pending evidence subscription and retries it after a runtime wake', async () => {
    const snapshot: ProfileSnapshot = {
      account: 'alice',
      publisherNamespaceId: 4,
      profileNamespaceId: 4,
      profileRev: 7,
      name: 'Alice',
      avatarDigest: null,
      bio: '',
    };
    resolveProfileEvidence
      .mockResolvedValueOnce({
        status: 'PENDING',
        key: {
          publisherNamespaceId: 4,
          profileNamespaceId: 4,
          account: 'alice',
          rev: 7,
        },
      })
      .mockResolvedValueOnce({ status: 'READY', profile: snapshot });
    const result = firstValueFrom(
      repository.resolve({
        publisherNamespaceId: 4,
        lookup: 'ACCOUNT_PROFILE',
        target: { profileNamespaceId: 4, account: 'alice', rev: 7 },
      }),
    );
    await vi.waitFor(() =>
      expect(resolveProfileEvidence).toHaveBeenCalledTimes(1),
    );

    profileWake.next({
      event: 'PROFILE_AVAILABLE',
      key: {
        publisherNamespaceId: 4,
        profileNamespaceId: 4,
        account: 'alice',
        rev: 7,
      },
    });

    await expect(result).resolves.toMatchObject({ name: 'Alice', rev: 7 });
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(2);
  });

  it('retries only the evidence whose pending exact profile key was committed', async () => {
    const alice = {
      publisherNamespaceId: 4,
      profileNamespaceId: 4,
      account: 'alice',
      profileRev: 7,
      name: 'Alice',
      avatarDigest: null,
      bio: '',
    } satisfies ProfileSnapshot;
    resolveProfileEvidence.mockImplementation(async (demand: ProfileDemand) => {
      const isAlice = demand.target.account === 'alice';
      const key = {
        publisherNamespaceId: 4,
        profileNamespaceId: 4,
        account: isAlice ? 'alice' : 'bob',
        rev: 7,
      };
      const calls = resolveProfileEvidence.mock.calls.filter(
        ([value]) => value.target.account === demand.target.account,
      ).length;
      return calls > 1 && isAlice
        ? { status: 'READY', profile: alice }
        : { status: 'PENDING', key };
    });

    const aliceResult = firstValueFrom(
      repository.resolve({
        publisherNamespaceId: 4,
        lookup: 'ACCOUNT_PROFILE',
        target: { profileNamespaceId: 4, account: 'alice', rev: 7 },
      }),
    );
    repository
      .resolve({
        publisherNamespaceId: 4,
        lookup: 'ACCOUNT_PROFILE',
        target: { profileNamespaceId: 4, account: 'bob', rev: 7 },
      })
      .subscribe();
    await vi.waitFor(() =>
      expect(resolveProfileEvidence).toHaveBeenCalledTimes(2),
    );

    profileWake.next({
      event: 'PROFILE_AVAILABLE',
      key: {
        publisherNamespaceId: 4,
        profileNamespaceId: 4,
        account: 'alice',
        rev: 7,
      },
    });

    await expect(aliceResult).resolves.toMatchObject({ account: 'alice' });
    expect(resolveProfileEvidence.mock.calls).toHaveLength(3);
    expect(resolveProfileEvidence.mock.calls[2][0]).toMatchObject({
      target: expect.objectContaining({ account: 'alice' }),
    });
  });
});
