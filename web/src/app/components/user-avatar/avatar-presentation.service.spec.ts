import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import {
  ProfileRepository,
  type ResolvedProfile,
} from '../../services/profile-store.service';
import { ProfileNamespaceRepository } from '../../services/profile-namespace-store.service';
import { AvatarPresentationService } from './avatar-presentation.service';
import { forwardAvatarSource } from '../forward-detail/forward-avatar-source';
import type { AvatarSource } from './avatar-source';
import type { AvatarView } from './avatar-view';
import { UserAvatarType } from './model';

const ref = {
  account: 'alice',
  publisherNamespaceId: 0,
  profileNamespaceId: 0,
  rev: 2,
  linked: true,
};
const demand: AvatarSource = {
  kind: 'demand',
  profile: ref,
  fallbackName: 'Captured Alice',
  account: 'alice',
};
const profile: ResolvedProfile = {
  publisherNamespaceId: 0,
  namespaceId: 0,
  account: 'alice',
  rev: 2,
  name: 'Pinned Alice',
  bio: '',
  avatarDigest: 'a'.repeat(64),
  avatarBlob: new Blob(['avatar']),
};

describe('AvatarPresentationService', () => {
  let updates: Subject<ResolvedProfile>;
  let resolve: ReturnType<typeof vi.fn>;
  let service: AvatarPresentationService;

  beforeEach(() => {
    updates = new Subject();
    resolve = vi.fn(() => updates);
    TestBed.configureTestingModule({
      providers: [
        { provide: ProfileRepository, useValue: { resolve } },
        {
          provide: ProfileNamespaceRepository,
          useValue: {
            resolve: vi.fn(() =>
              of({ domain: 'remote.test', status: 'ACTIVE' }),
            ),
          },
        },
      ],
    });
    service = TestBed.inject(AvatarPresentationService);
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:avatar');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it.each([null, 'data:image/png;base64,c2VudA=='])(
    'keeps an authoritative snapshot, including absent images: %s',
    (imageUrl) => {
      let view!: AvatarView;
      const subscription = service
        .resolve({ kind: 'snapshot', name: 'Sent Alice', imageUrl })
        .subscribe((value) => (view = value));
      expect(view.name).toBe('Sent Alice');
      expect(view.imageUrl).toBe(imageUrl);
      expect(resolve).not.toHaveBeenCalled();
      subscription.unsubscribe();
    },
  );

  it('resolves the exact pinned subject, with no stale source-image fallback', () => {
    let view!: AvatarView;
    const subscription = service
      .resolve(demand)
      .subscribe((value) => (view = value));
    expect(view.imageUrl).toBeNull();
    expect(view.name).toBe('Captured Alice');
    expect(resolve).toHaveBeenCalledWith({
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { account: 'alice', profileNamespaceId: 0, rev: 2 },
    });
    updates.next({ ...profile, avatarDigest: null, avatarBlob: null });
    expect(view.name).toBe('Pinned Alice');
    expect(view.imageUrl).toBeNull();
    subscription.unsubscribe();
  });

  it('uses cache-only resolution when the relationship is severed', () => {
    const subscription = service
      .resolve({ ...demand, profile: { ...ref, linked: false } })
      .subscribe();
    expect(resolve.mock.calls[0][0]).toMatchObject({
      demand: { lookup: 'ACCOUNT_PROFILE' },
    });
    subscription.unsubscribe();
  });

  it('shares mounted presentations and releases bytes only after the final consumer leaves', () => {
    const views: AvatarView[] = [];
    const first = service
      .resolve(demand)
      .subscribe((value) => views.push(value));
    const second = service
      .resolve({ ...demand })
      .subscribe((value) => views.push(value));
    updates.next(profile);
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(views.at(-1)).toBe(views.at(-2));
    first.unsubscribe();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    second.unsubscribe();
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:avatar');
    expect(updates.observed).toBe(false);
  });

  it('leases a shared digest across distinct subjects and never evicts an in-use image', () => {
    const first = service.resolve(demand).subscribe();
    const second = service
      .resolve({
        ...demand,
        profile: { ...ref, account: 'bob' },
        account: 'bob',
      })
      .subscribe();
    updates.next(profile);
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    first.unsubscribe();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    second.unsubscribe();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('keeps leases alive when a cached profile observable completes synchronously', () => {
    resolve.mockReturnValue(of(profile));
    const subscription = service.resolve(demand).subscribe();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    subscription.unsubscribe();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('clears presentation and leases when a demand errors', () => {
    let view!: AvatarView;
    const subscription = service
      .resolve(demand)
      .subscribe((value) => (view = value));
    updates.next(profile);
    updates.error(new Error('unavailable'));
    expect(view.name).toBe('Captured Alice');
    expect(view.imageUrl).toBeNull();
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });

  it('binds forward resources only to the bundle manifest and carrier, never to author identity', () => {
    const digest = 'b'.repeat(64);
    let view!: AvatarView;
    const profile = { displayName: 'Frozen Bob', avatarDigest: digest };
    const source = forwardAvatarSource(profile, {
      assets: [{ digest, bytes: 10 }],
      accessContext: { threadId: 42, seq: 7 },
    });
    service
      .resolve(source)
      .subscribe((value) => (view = value))
      .unsubscribe();
    expect(view).toEqual({
      name: 'Frozen Bob',
      type: UserAvatarType.OTHER,
      imageUrl: `/uploads/msg-assets/bb/bb/${digest}?threadId=42&seq=7`,
    });
    service
      .resolve(
        forwardAvatarSource(profile, {
          assets: [],
          accessContext: { threadId: 42, seq: 7 },
        }),
      )
      .subscribe((value) => (view = value))
      .unsubscribe();
    expect(view.imageUrl).toBeNull();
    service
      .resolve(forwardAvatarSource(profile, null))
      .subscribe((value) => (view = value))
      .unsubscribe();
    expect(view.imageUrl).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
    expect(
      TestBed.inject(ProfileNamespaceRepository).resolve,
    ).not.toHaveBeenCalled();
  });

  it('does not delay profile presentation while a namespace badge is unresolved', () => {
    const domains = new Subject<never>();
    vi.mocked(
      TestBed.inject(ProfileNamespaceRepository).resolve,
    ).mockReturnValue(domains);
    let view!: AvatarView;
    const subscription = service
      .resolve({
        ...demand,
        domainSource: {
          type: 'profile-namespace',
          publisherNamespaceId: 7,
          profileNamespaceId: 3,
        },
      })
      .subscribe((value) => (view = value));
    expect(view.name).toBe('Captured Alice');
    updates.next({ ...profile, avatarDigest: null, avatarBlob: null });
    expect(view.name).toBe('Pinned Alice');
    expect(view.federatedDomain).toBeNull();
    subscription.unsubscribe();
  });

  it('does not mark the local namespace and resolves publisher-scoped badges explicitly', () => {
    let view!: AvatarView;
    service
      .resolve({
        kind: 'snapshot',
        name: 'Local',
        imageUrl: null,
        domainSource: { type: 'namespace', namespaceId: 0 },
      })
      .subscribe((value) => (view = value))
      .unsubscribe();
    expect(view.federatedDomain).toBeNull();
    const subscription = service
      .resolve({
        ...demand,
        domainSource: {
          type: 'profile-namespace',
          publisherNamespaceId: 7,
          profileNamespaceId: 3,
        },
      })
      .subscribe((value) => (view = value));
    expect(
      TestBed.inject(ProfileNamespaceRepository).resolve,
    ).toHaveBeenCalledWith({ publisherNamespaceId: 7, profileNamespaceId: 3 });
    expect(view.federatedDomain).toBe('remote.test');
    subscription.unsubscribe();
  });

  it('stops publishing and releases images when the presentation is destroyed', () => {
    let view!: AvatarView;
    const subscription = service
      .resolve(demand)
      .subscribe((value) => (view = value));
    updates.next(profile);
    subscription.unsubscribe();
    expect(updates.observed).toBe(false);
    updates.next({ ...profile, name: 'Late' });
    expect(view.name).not.toBe('Late');
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });
});
