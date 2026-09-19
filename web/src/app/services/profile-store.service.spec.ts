import type { Mock } from 'vitest';
import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { firstValueFrom, Subject } from 'rxjs';
import {
  WebdbService,
  type ProfileSnapshot,
  type ProfileWake,
} from './webdb.service';
import { AvatarRepository } from './avatar-cache.service';
import { ProfileRepository } from './profile-store.service';
import { SessionLifecycleService } from './session-lifecycle.service';

describe('ProfileRepository', () => {
  let repo: ProfileRepository;
  let refreshSpy: Mock;
  let webdb: WebdbService;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ProfileRepository,
        WebdbService,
        {
          provide: AvatarRepository,
          useValue: {
            refresh: vi.fn().mockName('refresh').mockResolvedValue(undefined),
          },
        },
      ],
    });
    repo = TestBed.inject(ProfileRepository);
    webdb = TestBed.inject(WebdbService);
    refreshSpy = TestBed.inject(AvatarRepository).refresh as Mock;
    await webdb.openForUser('1');
  });

  afterEach(async () => {
    try {
      await webdb.closeAndDelete('1');
    } catch {
      /* already closed */
    }
  });

  it('stores a profile and fires avatar refresh on the first (path-setting) write', async () => {
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      sourceServer: 'local',
      name: 'Alice',
      avatar: '/uploads/avatars/a-512.webp',
      bio: '',
      profileRev: 1,
    });
    const got = await repo.getProfile({
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      profileRev: 1,
    });
    expect(got?.name).toBe('Alice');
    expect(got?.avatar).toBe('/uploads/avatars/a-512.webp');
    expect(refreshSpy).toHaveBeenCalledWith(
      'u9',
      '/uploads/avatars/a-512.webp',
    );
  });

  it('stores a new revision independently even when its avatar path is unchanged', async () => {
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      sourceServer: 'local',
      name: 'Alice',
      avatar: '/p/x',
      bio: '',
      profileRev: 1,
    });
    refreshSpy.mockClear();
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      sourceServer: 'local',
      name: 'Alice Smith',
      avatar: '/p/x',
      bio: '',
      profileRev: 2,
    });
    expect(refreshSpy).toHaveBeenCalledWith('u9', '/p/x');
    expect(
      (
        await repo.getProfile({
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
          profileRev: 2,
        })
      )?.name,
    ).toBe('Alice Smith');
  });

  it('refreshes when the avatar path changes', async () => {
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      sourceServer: 'local',
      name: 'Alice',
      avatar: '/p/old',
      bio: '',
      profileRev: 1,
    });
    refreshSpy.mockClear();
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      sourceServer: 'local',
      name: 'Alice',
      avatar: '/p/new',
      bio: '',
      profileRev: 2,
    });
    expect(refreshSpy).toHaveBeenCalledWith('u9', '/p/new');
  });

  it('does not fire refresh for an empty avatar (avatar cleared)', async () => {
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      sourceServer: 'local',
      name: 'Alice',
      avatar: '',
      bio: '',
      profileRev: 1,
    });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('getProfile returns undefined for an unknown identity', async () => {
    expect(
      await repo.getProfile({
        account: 'missing',
        domain: 'local',
        namespaceId: 0,
        profileRev: 1,
      }),
    ).toBeUndefined();
  });

  it('retains independently selected old and new revisions', async () => {
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      sourceServer: 'local',
      name: 'New',
      avatar: '/new',
      bio: '',
      profileRev: 5,
    });
    refreshSpy.mockClear();
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      namespaceId: 0,
      sourceServer: 'local',
      name: 'Old',
      avatar: '/old',
      bio: '',
      profileRev: 4,
    });
    expect(
      (
        await repo.getProfile({
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
          profileRev: 5,
        })
      )?.name,
    ).toBe('New');
    expect(
      (
        await repo.getProfile({
          account: 'alice',
          domain: 'local',
          namespaceId: 0,
          profileRev: 4,
        })
      )?.name,
    ).toBe('Old');
  });
});

describe('ProfileRepository resolution scheduler', () => {
  const profileWake = new Subject<ProfileWake>();
  const sessionEnded = new Subject<void>();
  const resolveProfileEvidence = vi.fn();
  let repository: ProfileRepository;

  beforeEach(() => {
    resolveProfileEvidence.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        ProfileRepository,
        {
          provide: WebdbService,
          useValue: {
            profileWake$: profileWake,
            resolveProfileEvidence,
          },
        },
        {
          provide: AvatarRepository,
          useValue: { refresh: vi.fn() },
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
      avatar: 'data:image/webp;base64,YQ==',
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
      avatarBase64: 'YQ==',
    });
    expect(await firstValueFrom(repository.resolve(evidence))).toMatchObject({
      namespaceId: 4,
      rev: 7,
    });
    expect(resolveProfileEvidence).toHaveBeenCalledTimes(1);
  });

  it('keeps a pending evidence subscription and retries it after a runtime wake', async () => {
    const snapshot: ProfileSnapshot = {
      account: 'alice',
      domain: 'peer.test',
      namespaceId: 4,
      profileRev: 7,
      name: 'Alice',
      avatar: '',
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

  it('retries only the evidence whose pending four-tuple was committed', async () => {
    const alice = {
      namespaceId: 4,
      account: 'alice',
      domain: 'peer.test',
      profileRev: 7,
      name: 'Alice',
      avatar: '',
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
