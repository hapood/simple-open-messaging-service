import type { Mock } from 'vitest';
import 'fake-indexeddb/auto';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { WebdbService } from './webdb.service';
import { AvatarRepository } from './avatar-cache.service';
import { ProfileRepository } from './profile-store.service';

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
