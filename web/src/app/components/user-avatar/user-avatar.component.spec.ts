import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { UserAvatarComponent, UserAvatarType } from './user-avatar.component';
import { AvatarRepository } from '../../services/avatar-cache.service';
import { UserService } from '../../services/user.service';
import { WebdbService } from '../../services/webdb.service';
import { ProfileRepository } from '../../services/profile-store.service';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { User } from '../../services/model';

describe('UserAvatarComponent (imgSrc branching)', () => {
  let fixture: ComponentFixture<UserAvatarComponent>;
  let getBlobSpy: jasmine.Spy;
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
            getBlob: jasmine.createSpy('getBlob').and.resolveTo(new Blob(['x'])),
            refreshTick: jasmine.createSpy('refreshTick').and.returnValue(0),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(UserAvatarComponent);
    getBlobSpy = TestBed.inject(AvatarRepository).getBlob as jasmine.Spy;
    sessionProfile.set(undefined);
  });

  it('falls back to the initial letter when there is no src (no DB call)', () => {
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    fixture.componentRef.setInput('name', 'Bob');
    fixture.componentRef.setInput('src', undefined);
    expect(fixture.componentInstance.showImage()).toBe(false);
    expect(fixture.componentInstance.initial()).toBe('B');
    expect(getBlobSpy).not.toHaveBeenCalled();
  });

  it('passes a local-preview src (blob:/data:) straight through without the DB', () => {
    fixture.componentRef.setInput('identityId', 9);
    fixture.componentRef.setInput('src', 'blob:http://localhost/abc');
    expect(fixture.componentInstance.imgSrc()).toBe('blob:http://localhost/abc');
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

    expect(getBlobSpy).toHaveBeenCalledWith('u7', '/uploads/avatars/self-512.webp');
    expect(fixture.componentInstance.showImage()).toBe(true);
  });
});

describe('UserAvatarComponent offline cold-start integration', () => {
  let webdb: WebdbService;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        UserService,
        WebdbService,
        ProfileRepository,
        AvatarRepository,
      ],
    });
    webdb = TestBed.inject(WebdbService);
    httpMock = TestBed.inject(HttpTestingController);
    localStorage.setItem('soms.lastUserId', '7');

    await webdb.openForUser('7');
    await webdb.putMeta('selfProfile', {
      id: 7,
      account: 'alice',
      name: 'Cached Alice',
      avatar: '/uploads/avatars/self-512.webp',
      bio: '',
      isForeigner: false,
      domain: '',
      createdAt: 0,
      updatedAt: 0,
      profileRev: 3,
      isDeleted: false,
      threadRevision: 1,
    } satisfies User);
    await webdb.putAvatar({
      identity: 'u7',
      // A real 1×1 GIF: the component's <img> load handler must accept it, just as it would a cached WebP.
      blob: new Blob(
        [Uint8Array.from(atob('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='), (c) => c.charCodeAt(0))],
        { type: 'image/gif' },
      ),
      path: '/uploads/avatars/self-512.webp',
      lastRender: Date.now(),
    });
  });

  afterEach(async () => {
    httpMock.verify();
    localStorage.removeItem('soms.lastUserId');
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
    expect(fixture.componentInstance.initial()).toBe('C');
    expect(fixture.componentInstance.imgSrc()).toMatch(/^blob:/);
    httpMock.expectNone('/uploads/avatars/self-512.webp');
  });
});
