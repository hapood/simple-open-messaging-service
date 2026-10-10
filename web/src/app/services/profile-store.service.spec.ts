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
            resolveProfileDemand: resolveProfileEvidence,
            getProfileAvatarBlob,
          },
        },
        {
          provide: SessionLifecycleService,
          useValue: { ended$: sessionEnded },
        },
      ],
    });
    repository = TestBed.inject(ProfileRepository);
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
      { evidence: null },
    );
    expect(repository['resolutions'].size).toBe(0);
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
    expect(repository['resolutions'].size).toBe(1);
    resolveProfileEvidence.mockResolvedValue({ status: 'READY', profile: snapshot });
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
    expect(repository['resolutions'].size).toBe(0);
    const subscription = repository.resolve(demand).subscribe();
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(2);
    expect(resolveProfileEvidence).toHaveBeenLastCalledWith(
      { ...demand, target: { ...demand.target, account: 'alice' } },
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
