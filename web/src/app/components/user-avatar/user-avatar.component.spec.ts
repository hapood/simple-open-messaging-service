import { Subject, of } from 'rxjs';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { UserAvatarComponent, UserAvatarType } from './user-avatar.component';
import { UserService } from '../../services/user.service';
import { WebdbService, type ProfileWake } from '../../services/webdb.service';
import { ProfileRepository } from '../../services/profile-store.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { createP2PConversation, type ConversationItem } from '../../services/model';

describe('UserAvatarComponent (imgSrc branching)', () => {
  let fixture: ComponentFixture<UserAvatarComponent>;
  const sessionProfile = signal<unknown>(undefined);
  const conversations = signal<ConversationItem[]>([]);

  let profileWake: Subject<ProfileWake>;

  beforeEach(() => {
    profileWake = new Subject<ProfileWake>();
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        UserAvatarComponent,
        { provide: UserService, useValue: { sessionProfile } },
        {
          provide: WebdbService,
          useValue: {
            profileWake$: profileWake.asObservable(),
            resolveProfileDemand: vi.fn(),
          },
        },
        {
          provide: ConversationListService,
          useValue: { items: conversations },
        },
        {
          provide: ProfileNamespaceRepository,
          useValue: {
            resolve: vi.fn(() => of({ domain: 'publisher.test', status: 'ACTIVE' })),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(UserAvatarComponent);
    sessionProfile.set(undefined);
    conversations.set([]);
  });

  it('resolves a publisher-owned avatar using the complete profile namespace pair', async () => {
    fixture.componentRef.setInput('domainSource', {
      type: 'profile-namespace',
      publisherNamespaceId: 7,
      profileNamespaceId: 0,
    });
    fixture.detectChanges();
    await fixture.whenStable();
    expect(TestBed.inject(ProfileNamespaceRepository).resolve).toHaveBeenCalledWith({
      publisherNamespaceId: 7,
      profileNamespaceId: 0,
    });
    expect(fixture.componentInstance.federatedMarkerDomain()).toBe('publisher.test');
  });

  it.each([false, true])(
    'uses resolved avatar absence instead of stale src (pending: %s)',
    async (pending) => {
      const db = TestBed.inject(WebdbService);
      const key = {
        publisherNamespaceId: 1,
        profileNamespaceId: 1,
        account: 'alice',
        rev: 2,
      };
      const profile = {
        publisherNamespaceId: 1,
        profileNamespaceId: 1,
        account: 'alice',
        profileRev: 2,
        name: 'Alice',
        avatarDigest: null,
        bio: '',
      };
      const resolve = vi.spyOn(db, 'resolveProfileDemand');
      if (pending) resolve.mockResolvedValueOnce({ status: 'PENDING', key });
      resolve.mockResolvedValue({ status: 'READY', profile });
      fixture.componentRef.setInput('src', 'data:image/webp;base64,b2xk');
      fixture.componentRef.setInput('profile', {
        account: 'alice',
        publisherNamespaceId: 1,
        profileNamespaceId: 1,
        rev: 2,
        linked: true,
      });
      fixture.detectChanges();
      await vi.waitFor(() => expect(resolve).toHaveBeenCalledTimes(1));
      if (pending) {
        expect(fixture.componentInstance.imgSrc()).toBe('');
        profileWake.next({ event: 'PROFILE_AVAILABLE', key });
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
    fixture.componentRef.setInput('domainSource', {
      type: 'snapshot',
      domain: 'peer.test',
    });
    fixture.componentRef.setInput('p2pThreadId', 42);
    vi.spyOn(TestBed.inject(ProfileRepository), 'resolve').mockReturnValue(new Subject());
    fixture.componentRef.setInput('profile', {
      account: 'alice',
      publisherNamespaceId: 0,
      profileNamespaceId: 4,
      rev: 1,
      linked: true,
    });
    const conversation = createP2PConversation(
      42,
      { account: 'alice', namespaceId: 4, profileRev: 1 },
      { alias: 'Friend' },
    );
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

  it('retries a failed image when the account changes with the same image source', async () => {
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    fixture.componentRef.setInput('account', 'alice');
    fixture.componentRef.setInput('src', '/uploads/avatars/shared.webp');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.imgFailed.set(true);
    expect(fixture.componentInstance.showImage()).toBe(false);

    fixture.componentRef.setInput('account', 'bob');
    fixture.detectChanges();
    await fixture.whenStable();
    expect(fixture.componentInstance.imgFailed()).toBe(false);
    expect(fixture.componentInstance.showImage()).toBe(true);
  });

  it('renders an account fallback when no profile name is cached', () => {
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    fixture.componentRef.setInput('account', 'bob');
    fixture.detectChanges();
    expect(fixture.componentInstance.effectiveName()).toBe('bob');
    expect(fixture.componentInstance.initial()).toBe('BO');
    expect(
      fixture.nativeElement
        .querySelector('[role="img"]')
        .getAttribute('aria-label'),
    ).toBe('bob avatar');
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

  it('uses account and domain for fallback color', () => {
    fixture.componentRef.setInput('type', UserAvatarType.GROUP);
    fixture.componentRef.setInput('account', '!group-account');
    fixture.componentRef.setInput('domainSource', {
      type: 'snapshot',
      domain: 'remote.example',
    });
    const color = fixture.componentInstance.groupFill().from;

    fixture.componentRef.setInput('name', 'Renamed group');

    expect(fixture.componentInstance.groupFill().from).toBe(color);
  });

  it('uses different colors for the same account on local and federated domains', () => {
    fixture.componentRef.setInput('type', UserAvatarType.OTHER);
    fixture.componentRef.setInput('account', 'alice');
    const localColor = fixture.componentInstance.bg();

    fixture.componentRef.setInput('domainSource', {
      type: 'snapshot',
      domain: 'remote.example',
    });

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
    fixture.componentRef.setInput('domainSource', {
      type: 'snapshot',
      domain: 'remote.example',
    });
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

  it('does not render the federated marker for the local namespace', () => {
    fixture.componentRef.setInput('name', 'Local user');
    fixture.componentRef.setInput('domainSource', {
      type: 'namespace',
      namespaceId: 0,
    });
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('.avatar-federated-icon'),
    ).toBeNull();
  });

  it('passes a local-preview src straight through', () => {
    fixture.componentRef.setInput('src', 'blob:http://localhost/abc');
    expect(fixture.componentInstance.imgSrc()).toBe(
      'blob:http://localhost/abc',
    );
  });

  it('uses a supplied server path when there is no profile evidence', () => {
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
