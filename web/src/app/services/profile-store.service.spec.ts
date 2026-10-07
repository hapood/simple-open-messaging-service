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

describe('ProfileRepository resolution scheduler', () => {
  const profileWake = new Subject<ProfileWake>();
  const sessionEnded = new Subject<void>();
  const resolveProfileEvidence = vi.fn();
  const getProfileAvatarBlob = vi.fn();
  let repository: ProfileRepository;

  beforeEach(() => {
    resolveProfileEvidence.mockReset();
    getProfileAvatarBlob.mockReset();
    getProfileAvatarBlob.mockResolvedValue(new Blob(['a'], { type: 'image/webp' }));
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
      avatarDigest: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
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
    resolveProfileEvidence.mockImplementation(
      async (demand: ProfileDemand) => {
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
      },
    );

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
      key: { publisherNamespaceId: 4, profileNamespaceId: 4, account: 'alice', rev: 7 },
    });

    await expect(aliceResult).resolves.toMatchObject({ account: 'alice' });
    expect(resolveProfileEvidence.mock.calls).toHaveLength(3);
    expect(resolveProfileEvidence.mock.calls[2][0]).toMatchObject({
      target: expect.objectContaining({ account: 'alice' }),
    });
  });
});
