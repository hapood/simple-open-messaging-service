import { Subject } from 'rxjs';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { UserAvatarComponent, UserAvatarType } from './user-avatar.component';
import { UserService } from '../../services/user.service';
import { WebdbService, type ProfileWake } from '../../services/webdb.service';
import { ProfileRepository } from '../../services/profile-store.service';
import { ConversationListService } from '../../services/conversation-list.service';
import type { ConversationItem } from '../../services/model';

describe('UserAvatarComponent (imgSrc branching)', () => {
  let fixture: ComponentFixture<UserAvatarComponent>;
  const sessionProfile = signal<unknown>(undefined);
  const conversations = signal<ConversationItem[]>([]);

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        UserAvatarComponent,
        { provide: UserService, useValue: { sessionProfile } },
        {
          provide: ConversationListService,
          useValue: { items: conversations },
        },
      ],
    });
    fixture = TestBed.createComponent(UserAvatarComponent);
    sessionProfile.set(undefined);
    conversations.set([]);
  });

  it.each([false, true])(
    'uses resolved avatar absence instead of stale src (pending: %s)',
    async (pending) => {
      const db = TestBed.inject(WebdbService);
      const key = {
        namespaceId: 1,
        account: 'alice',
        domain: 'alpha.test',
        rev: 2,
      };
      const profile = {
        namespaceId: 1,
        account: 'alice',
        domain: 'alpha.test',
        profileRev: 2,
        name: 'Alice',
        avatarDigest: null,
        bio: '',
      };
      const resolve = vi.spyOn(db, 'resolveProfileEvidence');
      if (pending) resolve.mockResolvedValueOnce({ status: 'PENDING', key });
      resolve.mockResolvedValue({ status: 'READY', profile });
      fixture.componentRef.setInput('src', 'data:image/webp;base64,b2xk');
      fixture.componentRef.setInput('profileEvidence', {
        type: 'EXACT',
        account: key.account,
        domain: key.domain,
        rev: key.rev,
      });
      fixture.detectChanges();
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
      if (pending) {
        expect(fixture.componentInstance.imgSrc()).toBe('');
        (
          db as unknown as { profileWake: Subject<ProfileWake> }
        ).profileWake.next({ event: 'PROFILE_AVAILABLE', key });
      }
      await vi.waitFor(() =>
        expect(fixture.componentInstance.initial()).toBe('AL'),
      );
      expect(fixture.componentInstance.imgSrc()).toBe('');
      expect(fixture.componentInstance.showImage()).toBe(false);
    },
  );

  it('reacts to P2P alias changes without overriding group member avatars', () => {
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    fixture.componentRef.setInput('name', 'Profile Name');
    fixture.componentRef.setInput('account', 'alice');
    fixture.componentRef.setInput('federatedDomain', 'peer.test');
    fixture.componentRef.setInput('p2pThreadId', 42);
    const conversation = {
      threadId: 42,
      type: 'P2P',
      peerUser: { account: 'alice', domain: 'peer.test' },
      alias: 'Friend',
    } as ConversationItem;
    conversations.set([conversation]);
    fixture.detectChanges();
    expect(fixture.componentInstance.initial()).toBe('FR');
    expect(
      fixture.nativeElement
        .querySelector('[role="img"]')
        .getAttribute('aria-label'),
    ).toBe('Friend avatar');
    conversations.set([{ ...conversation, alias: null }]);
    fixture.detectChanges();
    expect(fixture.componentInstance.initial()).toBe('PN');
    expect(
      fixture.nativeElement
        .querySelector('[role="img"]')
        .getAttribute('aria-label'),
    ).toBe('Profile Name avatar');
    conversations.set([conversation]);
    fixture.componentRef.setInput('p2pThreadId', undefined);
    expect(fixture.componentInstance.initial()).toBe('PN');
  });

  it('falls back to the first two characters when there is no src', () => {
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    fixture.componentRef.setInput('name', 'Bob');
    fixture.componentRef.setInput('src', undefined);
    expect(fixture.componentInstance.showImage()).toBe(false);
    expect(fixture.componentInstance.initial()).toBe('BO');
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

  it('uses account and domain rather than a numeric identity for fallback color', () => {
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

  it('passes a local-preview src straight through', () => {
    fixture.componentRef.setInput('identityId', 9);
    fixture.componentRef.setInput('src', 'blob:http://localhost/abc');
    expect(fixture.componentInstance.imgSrc()).toBe(
      'blob:http://localhost/abc',
    );
  });

  it('uses a supplied server path when there is no profile evidence', () => {
    fixture.componentRef.setInput('identityId', 5);
    fixture.componentRef.setInput('src', '/uploads/avatars/g-512.webp');
    expect(fixture.componentInstance.imgSrc()).toContain(
      '/uploads/avatars/g-512.webp',
    );
    expect(fixture.componentInstance.showImage()).toBe(true);
  });

  it('uses the generated fallback while the self profile has no revision', async () => {
    sessionProfile.set({
      id: 7,
      name: 'Alice',
      avatar: '/uploads/avatars/self-512.webp',
    });
    fixture.componentRef.setInput('type', UserAvatarType.SELF);
    fixture.componentRef.setInput('name', 'Alice');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(fixture.componentInstance.showImage()).toBe(false);
    expect(fixture.componentInstance.initial()).toBe('AL');
  });
});
