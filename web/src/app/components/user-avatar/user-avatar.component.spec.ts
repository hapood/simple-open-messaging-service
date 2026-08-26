import type { Mock } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { UserAvatarComponent, UserAvatarType } from './user-avatar.component';
import { AvatarRepository } from '../../services/avatar-cache.service';
import { UserService } from '../../services/user.service';
import { WebdbService } from '../../services/webdb.service';
import { ProfileRepository } from '../../services/profile-store.service';
import { provideHttpClient, withXhr } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import type { User } from '../../services/model';
import { PreferenceStore } from '../../services/preference-store.service';

describe('UserAvatarComponent (imgSrc branching)', () => {
  let fixture: ComponentFixture<UserAvatarComponent>;
  let getBlobSpy: Mock;
  const sessionProfile = signal<unknown>(undefined);

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        UserAvatarComponent,
        { provide: UserService, useValue: { sessionProfile } },
        {
          provide: AvatarRepository,
          useValue: {
            getBlob: vi
              .fn()
              .mockName('getBlob')
              .mockResolvedValue(new Blob(['x'])),
            refreshTick: vi.fn().mockName('refreshTick').mockReturnValue(0),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(UserAvatarComponent);
    getBlobSpy = TestBed.inject(AvatarRepository).getBlob as Mock;
    sessionProfile.set(undefined);
  });

  it('falls back to the first two characters when there is no src (no DB call)', () => {
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    fixture.componentRef.setInput('name', 'Bob');
    fixture.componentRef.setInput('src', undefined);
    expect(fixture.componentInstance.showImage()).toBe(false);
    expect(fixture.componentInstance.initial()).toBe('BO');
    expect(getBlobSpy).not.toHaveBeenCalled();
  });

  it('keeps an identified user color stable when the display name changes', () => {
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    fixture.componentRef.setInput('account', 'alice');
    fixture.componentRef.setInput('name', 'Alice');
    const color = fixture.componentInstance.bg();

    fixture.componentRef.setInput('name', 'Renamed Alice');

    expect(fixture.componentInstance.initial()).toBe('RA');
    expect(fixture.componentInstance.bg()).toBe(color);
  });

  it('uses the first two word initials for a multi-word name', () => {
    fixture.componentRef.setInput('name', 'Alice Smith');

    expect(fixture.componentInstance.initial()).toBe('AS');
  });

  it('uses the first two Chinese characters rather than the last two', () => {
    fixture.componentRef.setInput('name', '张小明');

    expect(fixture.componentInstance.initial()).toBe('张小');
  });

  it('does not split a composed emoji grapheme', () => {
    fixture.componentRef.setInput('name', '👩🏽\u200d💻Alice');

    expect(fixture.componentInstance.initial()).toBe('👩🏽\u200d💻A');
  });

  it('uses the dedicated graphite token for the self fallback avatar', () => {
    fixture.componentRef.setInput('type', UserAvatarType.SELF);

    expect(fixture.componentInstance.bg()).toBe('var(--app-avatar-self-bg)');
  });

  it('uses separate user and group identity namespaces for fallback colors', () => {
    fixture.componentRef.setInput('account', 'same-account');
    fixture.componentRef.setInput('name', 'Same label');
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    const userColor = fixture.componentInstance.bg();

    fixture.componentRef.setInput('type', UserAvatarType.GROUP);

    expect(fixture.componentInstance.groupFill().from).not.toBe(userColor);
  });

  it('uses functional blue while a group identity is not available', () => {
    fixture.componentRef.setInput('type', UserAvatarType.GROUP);
    fixture.componentRef.setInput('name', 'Draft group');
    const color = fixture.componentInstance.groupFill().from;

    fixture.componentRef.setInput('name', 'Renamed draft');

    expect(color).toBe('var(--app-action-primary)');
    expect(fixture.componentInstance.groupFill().from).toBe(color);
  });

  it('uses account and domain without changing the avatar cache identity', () => {
    fixture.componentRef.setInput('type', UserAvatarType.GROUP);
    fixture.componentRef.setInput('identityId', 12);
    fixture.componentRef.setInput('account', '!group-account');
    fixture.componentRef.setInput('federatedDomain', 'remote.example');
    const color = fixture.componentInstance.groupFill().from;

    fixture.componentRef.setInput('identityId', 99);

    expect(fixture.componentInstance.groupFill().from).toBe(color);
  });

  it('uses different colors for the same account on local and federated domains', () => {
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    fixture.componentRef.setInput('account', 'alice');
    const localColor = fixture.componentInstance.bg();

    fixture.componentRef.setInput('federatedDomain', 'remote.example');

    expect(fixture.componentInstance.bg()).not.toBe(localColor);
  });

  it('positions the group badge just beyond the avatar bottom-right edge', () => {
    fixture.componentRef.setInput('type', UserAvatarType.GROUP);
    fixture.componentRef.setInput('name', 'Group');
    fixture.detectChanges();

    const badgePath = fixture.nativeElement.querySelector(
      '.group-avatar-badge path',
    ) as SVGPathElement;
    expect(badgePath.getAttribute('transform')).toBe(
      'translate(71 76) scale(1.25)',
    );
  });

  it('renders the federated marker in the same scalable coordinate system as the avatar', () => {
    fixture.componentRef.setInput('name', 'Remote user');
    fixture.componentRef.setInput('federatedDomain', 'remote.example');
    fixture.detectChanges();

    const marker = fixture.nativeElement.querySelector(
      '.avatar-federated-icon',
    ) as SVGElement;
    expect(marker.getAttribute('viewBox')).toBe('0 0 100 100');
    expect(marker.querySelector('.avatar-federated-ground')).toBeNull();
    expect(marker.querySelector('.avatar-federated-disc')).not.toBeNull();
    expect(marker.querySelector('.avatar-federated-halo')).not.toBeNull();
    const globe = marker.querySelector('.avatar-federated-globe');
    expect(globe?.querySelector('circle')?.getAttribute('cx')).toBe('90');
    expect(globe?.querySelector('circle')?.getAttribute('cy')).toBe('10');
    expect(globe?.querySelector('circle')?.getAttribute('r')).toBe('10');
    expect(marker.querySelector('app-icon')).toBeNull();
  });

  it('does not render the federated marker for the local domain sentinel', () => {
    fixture.componentRef.setInput('name', 'Local user');
    fixture.componentRef.setInput('federatedDomain', 'local');
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('.avatar-federated-icon'),
    ).toBeNull();
  });

  it('passes a local-preview src (blob:/data:) straight through without the DB', () => {
    fixture.componentRef.setInput('identityId', 9);
    fixture.componentRef.setInput('src', 'blob:http://localhost/abc');
    expect(fixture.componentInstance.imgSrc()).toBe(
      'blob:http://localhost/abc',
    );
    expect(getBlobSpy).not.toHaveBeenCalled();
  });

  it('renders nothing for a server-path avatar before the async DB resolve lands', () => {
    // A /uploads path goes through IDB (async); imgSrc is '' until the blob resolves → initial-letter.
    fixture.componentRef.setInput('identityId', 5);
    fixture.componentRef.setInput('src', '/uploads/avatars/g-512.webp');
    expect(fixture.componentInstance.imgSrc()).toBe('');
    expect(fixture.componentInstance.showImage()).toBe(false);
  });

  it('resolves an omitted SELF avatar through the session identity and IndexedDB repository', async () => {
    sessionProfile.set({
      id: 7,
      name: 'Alice',
      avatar: '/uploads/avatars/self-512.webp',
    });
    fixture.componentRef.setInput('type', UserAvatarType.SELF);
    fixture.componentRef.setInput('name', 'Alice');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(getBlobSpy).toHaveBeenCalledWith(
      'u7',
      '/uploads/avatars/self-512.webp',
    );
    expect(fixture.componentInstance.showImage()).toBe(true);
  });
});

describe('UserAvatarComponent offline cold-start integration', () => {
  let webdb: WebdbService;
  let httpMock: HttpTestingController;
  let preferences: PreferenceStore;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        UserService,
        WebdbService,
        ProfileRepository,
        AvatarRepository,
      ],
    });
    webdb = TestBed.inject(WebdbService);
    httpMock = TestBed.inject(HttpTestingController);
    preferences = TestBed.inject(PreferenceStore);
    await preferences.set('device', 'soms.lastUserId', 7);

    await webdb.openForUser('7');
    await webdb.putMeta('selfProfile', {
      id: 7,
      account: 'alice',
      name: 'Cached Alice',
      avatar: '/uploads/avatars/self-512.webp',
      bio: '',
      isGroup: false,
      domain: 'local',
      createdAt: 0,
      updatedAt: 0,
      profileRev: 3,
      isDeleted: false,
    } satisfies User);
    await webdb.putAvatar({
      identity: 'u7',
      // A real 1×1 GIF: the component's <img> load handler must accept it, just as it would a cached WebP.
      blob: new Blob(
        [
          Uint8Array.from(
            atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='),
            (c) => c.charCodeAt(0),
          ),
        ],
        { type: 'image/gif' },
      ),
      path: '/uploads/avatars/self-512.webp',
      lastRender: Date.now(),
    });
  });

  afterEach(async () => {
    httpMock.verify();
    await preferences.remove('device', 'soms.lastUserId');
    await webdb.closeAndDelete('7');
  });

  it('restores the self name and avatar entirely from IndexedDB without HTTP', async () => {
    const userService = TestBed.inject(UserService);
    await userService.restoreWebdb();

    const fixture = TestBed.createComponent(UserAvatarComponent);
    fixture.componentRef.setInput('type', UserAvatarType.SELF);
    fixture.detectChanges();
    // The component effect deliberately starts an untracked IndexedDB promise; whenStable() cannot see it.
    // Yield until that repository read has minted the object URL, without allowing any network fallback.
    for (let i = 0; i < 20 && !fixture.componentInstance.imgSrc(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      fixture.detectChanges();
    }

    expect(userService.sessionProfile()?.name).toBe('Cached Alice');
    expect(fixture.componentInstance.initial()).toBe('CA');
    expect(fixture.componentInstance.imgSrc()).toMatch(/^blob:/);
    httpMock.expectNone('/uploads/avatars/self-512.webp');
  });
});
