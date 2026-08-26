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
      sourceServer: 'local',
      name: 'Alice',
      avatar: '/uploads/avatars/a-512.webp',
      profileRev: 1,
    });
    const got = await repo.getProfile('u9');
    expect(got?.name).toBe('Alice');
    expect(got?.avatar).toBe('/uploads/avatars/a-512.webp');
    expect(refreshSpy).toHaveBeenCalledWith(
      'u9',
      '/uploads/avatars/a-512.webp',
    );
  });

  it('does NOT refresh when the avatar path is unchanged (name-only update)', async () => {
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      sourceServer: 'local',
      name: 'Alice',
      avatar: '/p/x',
      profileRev: 1,
    });
    refreshSpy.mockClear();
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      sourceServer: 'local',
      name: 'Alice Smith',
      avatar: '/p/x',
      profileRev: 2,
    });
    expect(refreshSpy).not.toHaveBeenCalled();
    expect((await repo.getProfile('u9'))?.name).toBe('Alice Smith');
  });

  it('refreshes when the avatar path changes', async () => {
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      sourceServer: 'local',
      name: 'Alice',
      avatar: '/p/old',
      profileRev: 1,
    });
    refreshSpy.mockClear();
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      sourceServer: 'local',
      name: 'Alice',
      avatar: '/p/new',
      profileRev: 2,
    });
    expect(refreshSpy).toHaveBeenCalledWith('u9', '/p/new');
  });

  it('does not fire refresh for an empty avatar (avatar cleared)', async () => {
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      sourceServer: 'local',
      name: 'Alice',
      avatar: '',
      profileRev: 1,
    });
    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('getProfile returns undefined for an unknown identity', async () => {
    expect(await repo.getProfile('u999')).toBeUndefined();
  });

  it('does not let an older profile revision overwrite a newer one', async () => {
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      sourceServer: 'local',
      name: 'New',
      avatar: '/new',
      profileRev: 5,
    });
    refreshSpy.mockClear();
    await repo.putProfile('u9', 'user', {
      id: 9,
      account: 'alice',
      domain: 'local',
      sourceServer: 'local',
      name: 'Old',
      avatar: '/old',
      profileRev: 4,
    });
    expect((await repo.getProfile('u9'))?.name).toBe('New');
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});
