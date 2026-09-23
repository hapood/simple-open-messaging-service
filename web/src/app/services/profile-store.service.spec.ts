import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { firstValueFrom, Subject } from 'rxjs';
import {
  WebdbService,
  type ProfileSnapshot,
  type ProfileWake,
} from './webdb.service';
import { ProfileRepository } from './profile-store.service';
import { SessionLifecycleService } from './session-lifecycle.service';

describe('ProfileRepository resolution scheduler', () => {
  const profileWake = new Subject<ProfileWake>();
  const sessionEnded = new Subject<void>();
  const resolveProfileEvidence = vi.fn();
  const getProfileAvatarBlob = vi.fn();
  const getProfile = vi.fn();
  let repository: ProfileRepository;

  beforeEach(() => {
    resolveProfileEvidence.mockReset();
    getProfileAvatarBlob.mockReset();
    getProfile.mockReset();
    getProfileAvatarBlob.mockResolvedValue(new Blob(['a'], { type: 'image/webp' }));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ProfileRepository,
        {
          provide: WebdbService,
          useValue: {
            profileWake$: profileWake,
            resolveProfileEvidence,
            getProfileAvatarBlob,
            getProfile,
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

  it('reuses a committed four-tuple from the main-thread LRU', async () => {
    const snapshot: ProfileSnapshot = {
      account: 'alice',
      domain: 'peer.test',
      namespaceId: 4,
      profileRev: 7,
      name: 'Alice',
      avatarDigest: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
      bio: 'Bio',
    };
    resolveProfileEvidence.mockResolvedValue({
      status: 'READY',
      profile: snapshot,
    });
    const evidence = {
      type: 'EXACT' as const,
      account: 'ALICE',
      domain: 'PEER.TEST',
      rev: 7,
    };

    expect(await firstValueFrom(repository.resolve(evidence))).toMatchObject({
      namespaceId: 4,
      account: 'alice',
      domain: 'peer.test',
      rev: 7,
      avatarDigest: snapshot.avatarDigest,
      avatarBlob: expect.any(Blob),
    });
    expect(await firstValueFrom(repository.resolve(evidence))).toMatchObject({
      namespaceId: 4,
      rev: 7,
    });
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(1);
    expect(getProfileAvatarBlob).toHaveBeenCalledOnce();
  });

  it('keeps a pending evidence subscription and retries it after a runtime wake', async () => {
    const snapshot: ProfileSnapshot = {
      account: 'alice',
      domain: 'peer.test',
      namespaceId: 4,
      profileRev: 7,
      name: 'Alice',
      avatarDigest: null,
      bio: '',
    };
    resolveProfileEvidence
      .mockResolvedValueOnce({
        status: 'PENDING',
        key: {
          namespaceId: 4,
          account: 'alice',
          domain: 'peer.test',
          rev: 7,
        },
      })
      .mockResolvedValueOnce({ status: 'READY', profile: snapshot });
    const result = firstValueFrom(
      repository.resolve({
        type: 'MESSAGE_AUTHOR',
        threadId: 9,
        messageSeq: 12,
        rev: 7,
      }),
    );
    await vi.waitFor(() =>
      expect(resolveProfileEvidence).toHaveBeenCalledTimes(1),
    );

    profileWake.next({
      event: 'PROFILE_AVAILABLE',
      key: {
        namespaceId: 4,
        account: 'alice',
        domain: 'peer.test',
        rev: 7,
      },
    });

    await expect(result).resolves.toMatchObject({ name: 'Alice', rev: 7 });
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(2);
  });

  it('settles a drifting Group Meta request under its own evidence', async () => {
    const evidence = {
      type: 'GROUP_META' as const, threadId: 9, profileRev: 4,
      subject: { type: 'MEMBER' as const, account: 'alice', domain: 'peer.test' },
    };
    const expected = { namespaceId: 7, account: 'alice', domain: 'peer.test', rev: 4 };
    const actual = { ...expected, rev: 5 };
    resolveProfileEvidence.mockResolvedValue({ status: 'PENDING', key: expected });
    getProfile.mockResolvedValue({ ...actual, profileRev: 5, name: 'Alice 5', bio: '', avatarDigest: null });
    const result = firstValueFrom(repository.resolve(evidence));
    await vi.waitFor(() => expect(resolveProfileEvidence).toHaveBeenCalledOnce());
    profileWake.next({ event: 'PROFILE_AVAILABLE', key: actual, evidence });
    await expect(result).resolves.toMatchObject({ name: 'Alice 5', rev: 5 });
    expect(getProfile).toHaveBeenCalledWith({
      account: 'alice', domain: 'peer.test', namespaceId: 7, profileRev: 5,
    });
    expect(resolveProfileEvidence).toHaveBeenCalledOnce();
  });

  it('retries only the evidence whose pending four-tuple was committed', async () => {
    const alice = {
      namespaceId: 4,
      account: 'alice',
      domain: 'peer.test',
      profileRev: 7,
      name: 'Alice',
      avatarDigest: null,
      bio: '',
    } satisfies ProfileSnapshot;
    resolveProfileEvidence.mockImplementation(
      async (evidence: { type: string; account?: string }) => {
        const isAlice = evidence.account === 'alice';
        const key = {
          namespaceId: 4,
          account: isAlice ? 'alice' : 'bob',
          domain: 'peer.test',
          rev: 7,
        };
        const calls = resolveProfileEvidence.mock.calls.filter(
          ([value]) => value.account === evidence.account,
        ).length;
        return calls > 1 && isAlice
          ? { status: 'READY', profile: alice }
          : { status: 'PENDING', key };
      },
    );

    const aliceResult = firstValueFrom(
      repository.resolve({
        type: 'EXACT',
        account: 'alice',
        domain: 'peer.test',
        rev: 7,
      }),
    );
    repository
      .resolve({
        type: 'EXACT',
        account: 'bob',
        domain: 'peer.test',
        rev: 7,
      })
      .subscribe();
    await vi.waitFor(() =>
      expect(resolveProfileEvidence).toHaveBeenCalledTimes(2),
    );

    profileWake.next({
      event: 'PROFILE_AVAILABLE',
      key: { namespaceId: 4, account: 'alice', domain: 'peer.test', rev: 7 },
    });

    await expect(aliceResult).resolves.toMatchObject({ account: 'alice' });
    expect(resolveProfileEvidence.mock.calls).toHaveLength(3);
    expect(resolveProfileEvidence.mock.calls[2][0]).toMatchObject({
      account: 'alice',
    });
  });
});
