import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { UserService } from '../../services/user.service';
import {
  ProfileRepository,
  type ResolvedProfile,
} from '../../services/profile-store.service';
import { AvatarComponent } from './avatar.component';
import { DemandAvatarComponent } from './demand-avatar.component';
import { SnapshotAvatarComponent } from './snapshot-avatar.component';
import { UserAvatarType } from './model';
import { By } from '@angular/platform-browser';

const self = { account: 'me', name: 'Session Name', profileRev: 3 };
const profile: ResolvedProfile = {
  publisherNamespaceId: 0,
  namespaceId: 0,
  account: 'me',
  rev: 3,
  name: 'Committed Name',
  bio: '',
  avatarDigest: null,
  avatarBlob: null,
};

describe('avatar source adapters', () => {
  it('selects the pinned session profile only in the demand adapter', async () => {
    const updates = new Subject<ResolvedProfile>();
    const resolve = vi.fn(() => updates);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: { sessionProfile: signal(self) } },
        { provide: ProfileRepository, useValue: { resolve } },
      ],
    });
    const fixture = TestBed.createComponent(DemandAvatarComponent);
    fixture.componentRef.setInput('type', UserAvatarType.SELF);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(resolve).toHaveBeenCalledWith({
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { account: 'me', profileNamespaceId: 0, rev: 3 },
    });
    updates.next(profile);
    fixture.detectChanges();
    expect(fixture.componentInstance.view().name).toBe('Committed Name');
    fixture.destroy();
    expect(updates.observed).toBe(false);
  });

  it('cancels the old subject and clears its presentation before resolving a replacement', async () => {
    const old = new Subject<ResolvedProfile>();
    const next = new Subject<ResolvedProfile>();
    const resolve = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(next);
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: UserService,
          useValue: { sessionProfile: signal(undefined) },
        },
        { provide: ProfileRepository, useValue: { resolve } },
      ],
    });
    const fixture = TestBed.createComponent(DemandAvatarComponent);
    fixture.componentRef.setInput('profile', {
      account: 'me',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      rev: 3,
      linked: true,
    });
    fixture.componentRef.setInput('name', 'Captured');
    fixture.detectChanges();
    await fixture.whenStable();
    old.next(profile);
    fixture.detectChanges();
    expect(fixture.componentInstance.view().name).toBe('Committed Name');
    fixture.componentRef.setInput('profile', {
      account: 'bob',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      rev: 1,
      linked: true,
    });
    fixture.componentRef.setInput('name', 'Captured Bob');
    expect(fixture.componentInstance.view().name).toBe('Captured Bob');
    expect(fixture.componentInstance.view().imageUrl).toBeNull();
    fixture.detectChanges();
    await fixture.whenStable();
    expect(old.observed).toBe(false);
    expect(fixture.componentInstance.view().name).toBe('Captured Bob');
    old.next({ ...profile, name: 'Late Old Name' });
    expect(fixture.componentInstance.view().name).toBe('Captured Bob');
    next.next({ ...profile, account: 'bob', rev: 1, name: 'Pinned Bob' });
    expect(fixture.componentInstance.view().name).toBe('Pinned Bob');
    fixture.destroy();
    expect(next.observed).toBe(false);
  });

  it.each([null, 'blob:local-preview'])(
    'renders an explicit snapshot without session or profile providers: %s',
    async (src) => {
      TestBed.configureTestingModule({
        providers: [provideZonelessChangeDetection()],
      });
      const fixture = TestBed.createComponent(SnapshotAvatarComponent);
      fixture.componentRef.setInput('type', UserAvatarType.SELF);
      fixture.componentRef.setInput('name', 'Frozen Name');
      fixture.componentRef.setInput('src', src);
      expect(fixture.componentInstance.view().name).toBe('Frozen Name');
      expect(fixture.componentInstance.view().imageUrl).toBe(src);
      fixture.detectChanges();
      await fixture.whenStable();
      expect(fixture.componentInstance.view().name).toBe('Frozen Name');
      expect(fixture.componentInstance.view().imageUrl).toBe(src);
      const renderer = fixture.debugElement.query(By.directive(AvatarComponent))
        .componentInstance as AvatarComponent;
      expect(renderer.initial()).toBe('FN');
      expect(renderer.showImage()).toBe(src !== null);
      fixture.destroy();
    },
  );

  it('does not query a session profile without a committed revision', async () => {
    const resolve = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: UserService,
          useValue: {
            sessionProfile: signal({
              ...self,
              account: 'qifaai2',
              name: 'qifaai2',
              profileRev: 0,
            }),
          },
        },
        { provide: ProfileRepository, useValue: { resolve } },
      ],
    });
    const fixture = TestBed.createComponent(DemandAvatarComponent);
    fixture.componentRef.setInput('type', UserAvatarType.SELF);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.view().name).toBe('qifaai2');
    expect(fixture.componentInstance.view().imageUrl).toBeNull();
    const renderer = fixture.debugElement.query(By.directive(AvatarComponent))
      .componentInstance as AvatarComponent;
    expect(renderer.initial()).toBe('QI');
    expect(renderer.loading()).toBe(false);
    expect(fixture.nativeElement.querySelector('.avatar-placeholder')).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    fixture.destroy();
  });
});
