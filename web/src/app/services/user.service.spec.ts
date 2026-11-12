import type { Mock } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import {
  HttpClient,
  provideHttpClient,
  HttpRequest,
  withXhr,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { firstValueFrom, of } from 'rxjs';
import { CACHE_REBUILD_RELOAD, UserService } from './user.service';
import { REQUEST_SCOPE, RequestScope } from '../request-context';
import { LocalCacheVersionMismatchError, WebdbService } from './webdb.service';
import { ProfileRepository } from './profile-store.service';
import { User } from './model';
import { PreferenceStore } from './preference-store.service';
import { SessionLifecycleService } from './session-lifecycle.service';

/** Match the POST /user/my-profile request regardless of the runtime apiOrigin (empty same-origin in
 *  the browser, absolute under Tauri). */
const isMyProfile = (req: HttpRequest<unknown>): boolean =>
  req.method === 'POST' && req.url.endsWith('/user/my-profile');
/** A minimal my-profile response body; `over` overrides fields under test. */
const profile = (
  over: Partial<User>,
): {
  code: number;
  data: User;
} => ({
  code: 0,
  data: {
    id: 1,
    name: 'A',
    avatar: '',
    bio: '',
    isGroup: false,
    isDeleted: false,
    account: 'alice',
    namespaceId: 0,
    profileRev: 1,
    ...over,
  } as User,
});

describe('UserService federated resolve SSE', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('ignores heartbeats, decodes fragmented progress, and closes on the terminal result', async () => {
    const service = Object.create(UserService.prototype) as UserService;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const text =
          'event: heartbeat\r\ndata: {}\r\n\r\nevent: progress\r\ndata: {"stage":"DISCOVERING"}\r\n\r\nevent: resolved\r\ndata: {"user":{"account":"bob"}}\r\n\r\n';
        for (const character of text)
          controller.enqueue(new TextEncoder().encode(character));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const progress = vi.fn();
    const result = await firstValueFrom(
      service.resolveFederatedUser(
        { account: 'bob', domain: 'peer.example' },
        progress,
      ),
    );
    expect(result.user.account).toBe('bob');
    expect(progress).toHaveBeenCalledExactlyOnceWith('DISCOVERING');
    // Allow attempt cleanup after Observable completion to release the locked reader.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});

describe('UserService.localRelationship', () => {
  it.each([
    { namespaceId: 7, state: 'ACTIVE', expected: 'FRIEND' },
    { namespaceId: 8, state: 'ACTIVE', expected: 'NONE' },
    { namespaceId: 7, state: 'READ_ONLY', expected: 'NONE' },
  ])('checks group membership by namespace and account: %j', async (value) => {
    const service = Object.create(UserService.prototype) as UserService;
    Object.assign(service, {
      webdb: {
        getThreads: async () => [
          {
            type: 'GROUP',
            conversationState: value.state,
            account: '!team',
            publisherNamespaceId: value.namespaceId,
          },
        ],
      },
    });
    await expect(
      service.localRelationship({ id: 0, account: '!team', namespaceId: 7 }),
    ).resolves.toBe(value.expected);
  });

  it('matches transient federated users by exact Address across request pages', async () => {
    const service = Object.create(UserService.prototype) as UserService;
    const record = (account: string) => ({
      id: `request:${account}`,
      kind: 'FRIEND',
      author: { account: 'me', namespaceId: 0 },
      receiver: { id: 0, account, namespaceId: 7 },
      direction: 'OUTGOING' as const,
      snapshot: { displayName: account, avatar: null },
      status: 'REQUESTED' as const,
      note: '',
      requestedAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-08T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    });
    const queryRelationshipRequests = vi.fn(
      (params: { bucket: 'SENT' | 'RECEIVED'; before?: string }) => {
        const continuation =
          params.bucket === 'SENT' && params.before === undefined;
        return of({
          code: 0,
          message: 'ok',
          data: {
            items:
              params.bucket === 'SENT'
                ? continuation
                  ? [record('someone-else')]
                  : [record('bob')]
                : [],
            hasMore: continuation,
            before: continuation ? 'next-page' : null,
          },
        });
      },
    );
    Object.assign(service, {
      webdb: {
        getThreads: async () => [
          {
            type: 'P2P',
            conversationState: 'ACTIVE',
            peerUser: {
              id: 0,
              account: 'someone-else',
              namespaceId: 7,
            },
          },
        ],
      },
      queryRelationshipRequests,
    });

    await expect(
      service.localRelationship({
        id: 0,
        account: 'bob',
        namespaceId: 7,
      }),
    ).resolves.toBe('OUTGOING_PENDING');
    expect(queryRelationshipRequests).toHaveBeenCalledTimes(2);
  });
});

describe('UserService profile refresh', () => {
  let svc: UserService;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        UserService,
        // The constructor effect touches WebdbService (open/close on id change) + ensureProfile writes the
        // self-profile through to BOTH ProfileRepository and WebdbService.putMeta('selfProfile') — all side
        // effects irrelevant to the refresh contract, so stub them. sessionProfile is the real signal under test.
        {
          provide: WebdbService,
          useValue: {
            openForUser: vi
              .fn()
              .mockName('openForUser')
              .mockResolvedValue(undefined),
            openExistingForUser: vi
              .fn()
              .mockName('openExistingForUser')
              .mockResolvedValue(undefined),
            recreateForUser: vi
              .fn()
              .mockName('recreateForUser')
              .mockResolvedValue(undefined),
            closeAndDelete: vi
              .fn()
              .mockName('closeAndDelete')
              .mockResolvedValue(undefined),
            readAccountState: vi
              .fn()
              .mockName('readAccountState')
              .mockResolvedValue(undefined),
            writeSelfProfile: vi
              .fn()
              .mockName('writeSelfProfile')
              .mockResolvedValue(undefined),
            writeComposerDrafts: vi
              .fn()
              .mockName('writeComposerDrafts')
              .mockResolvedValue(undefined),
            advanceIntentRequestRead: vi
              .fn()
              .mockName('advanceIntentRequestRead')
              .mockResolvedValue(undefined),
          },
        },
        {
          provide: ProfileRepository,
          useValue: {
            resolve: vi.fn().mockReturnValue(
              of({
                name: 'A',
                bio: '',
                avatarDigest: null,
                avatarBlob: null,
              }),
            ),
          },
        },
      ],
    });
    svc = TestBed.inject(UserService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('classifies account registration as authentication rather than server metadata', () => {
    const next = vi.fn();
    svc.register({ account: 'alice', password: 'password' }).subscribe(next);
    const request = httpMock.expectOne('/api/v1/user/register');
    expect(request.request.context.get(REQUEST_SCOPE)).toBe(
      RequestScope.Authentication,
    );
    const response = {
      code: 0,
      message: 'ok',
      data: { id: 1, account: 'alice' },
    };
    request.flush(response);
    expect(next).toHaveBeenCalledWith(response);
  });

  it('publishes a revision-zero account without resolving a profile', async () => {
    const result = firstValueFrom(svc.ensureProfile());
    const account = {
      id: 3,
      account: 'qifaai2',
      namespaceId: 0,
      profileRev: 0,
      isGroup: false,
      isDeleted: false,
    };
    httpMock.expectOne(isMyProfile).flush({ code: 0, data: account });
    const expected = { ...account, name: 'qifaai2', bio: '' };
    expect(await result).toEqual(expected);
    expect(svc.sessionProfile()).toEqual(expected);
    expect(TestBed.inject(WebdbService).writeSelfProfile).toHaveBeenCalledWith(
      account,
    );
    expect(TestBed.inject(ProfileRepository).resolve).not.toHaveBeenCalled();
  });

  it('resolves the first published revision after a revision-zero account', async () => {
    const account = {
      id: 3,
      account: 'qifaai2',
      namespaceId: 0,
      profileRev: 0,
      isGroup: false,
      isDeleted: false,
    };
    const initial = firstValueFrom(svc.ensureProfile());
    httpMock.expectOne(isMyProfile).flush({ code: 0, data: account });
    await initial;
    const refreshed = firstValueFrom(svc.ensureProfile({ force: true }));
    httpMock.expectOne(isMyProfile).flush({
      code: 0,
      data: { ...account, profileRev: 1 },
    });
    expect(await refreshed).toMatchObject({ profileRev: 1, name: 'A' });
    expect(
      TestBed.inject(ProfileRepository).resolve,
    ).toHaveBeenCalledExactlyOnceWith({
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'qifaai2', rev: 1 },
    });
  });

  it('rejects a missing account rather than interpreting it as revision zero', async () => {
    const result = firstValueFrom(svc.ensureProfile());
    const rejected = expect(result).rejects.toThrow('missing self account');
    httpMock.expectOne(isMyProfile).flush({ code: 0, data: null });
    await rejected;
    expect(svc.sessionProfile()).toBeUndefined();
    expect(TestBed.inject(ProfileRepository).resolve).not.toHaveBeenCalled();
  });

  // The force-refresh contract guard. updateSessionProfile() must ALWAYS hit the network — it calls
  // ensureProfile({ force: true }). Before the fix it passed no `force`, so once sessionProfile was
  // populated ensureProfile short-circuited to of(cached): a live change never re-fetched, so the new
  // value never reached sessionProfile (post-edit avatar/name-bio refresh + the PROFILE_REV_UPDATED
  // multi-device refresh suffered the same staleness). The second call here MUST issue a second request
  // and adopt its CHANGED response — only force does that.
  it('updateSessionProfile() forces a re-fetch even when sessionProfile is already set', async () => {
    // First refresh seeds sessionProfile with name = 'A'. The cold POST is subscribed inside
    // updateSessionProfile — expectOne throws until it arrives, and waitFor retries on that throw.
    svc.updateSessionProfile();
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush(
      profile({ name: 'A' }),
    );
    await vi.waitFor(() => expect(svc.sessionProfile()?.name).toBe('A'));

    vi.mocked(TestBed.inject(ProfileRepository).resolve).mockReturnValue(
      of({
        publisherNamespaceId: 0,
        namespaceId: 0,
        account: 'alice',
        domain: 'local',
        rev: 2,
        name: 'B',
        bio: '',
        avatarDigest: null,
        avatarBlob: null,
      }),
    );
    // Second refresh — sessionProfile is already set. The bug would short-circuit here (no request,
    // stale 'A' stays). The fix issues the request regardless and adopts the new value.
    svc.updateSessionProfile();
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush(
      profile({ name: 'B' }),
    );
    await vi.waitFor(() => expect(svc.sessionProfile()?.name).toBe('B'));
  });

  it('persists only account facts and derives self display from the runtime profile', async () => {
    const result = firstValueFrom(svc.ensureProfile());
    vi.mocked(TestBed.inject(ProfileRepository).resolve).mockReturnValue(
      of({
        publisherNamespaceId: 0,
        namespaceId: 0,
        account: 'alice',
        domain: 'local',
        rev: 2,
        name: 'Resolved Alice',
        bio: 'Resolved bio',
        avatarDigest:
          'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
        avatarBlob: new Blob(['a'], { type: 'image/webp' }),
      }),
    );
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush(
      profile({ profileRev: 2, avatar: '/uploads/old-path.webp' }),
    );
    const view = await result;
    expect(view).toMatchObject({
      name: 'Resolved Alice',
      bio: 'Resolved bio',
    });
    expect(view).not.toHaveProperty('avatar');
    expect(TestBed.inject(ProfileRepository).resolve).toHaveBeenCalledWith({
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: {
        profileNamespaceId: 0,
        account: 'alice',
        rev: 2,
      },
    });
    expect(TestBed.inject(WebdbService).writeSelfProfile).toHaveBeenCalledWith({
      id: 1,
      account: 'alice',
      namespaceId: 0,
      profileRev: 2,
      isGroup: false,
      isDeleted: false,
    });
  });

  // Contrast: ensureProfile() (no force) is the idempotent get-or-load — it DOES short-circuit to the
  // cached sessionProfile on a second call (of(cached), no HTTP). This is precisely the behavior
  // updateSessionProfile must NOT inherit; pinning both keeps the two accessors' contracts explicit
  // so the force cannot be "simplified" back out of the refresh path.
  it('ensureProfile() (no force) short-circuits to the cached profile on the second call', async () => {
    const first = firstValueFrom(svc.ensureProfile());
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush(
      profile({ name: 'A' }),
    );
    await first;
    expect(svc.sessionProfile()?.name).toBe('A');

    // Second call: sessionProfile is set → returns of(cached) synchronously, NO HTTP request.
    let emitted: ReturnType<UserService['sessionProfile']>;
    svc.ensureProfile().subscribe((u) => (emitted = u));
    expect(emitted?.name).toBe('A'); // served from cache, not the network
    httpMock.expectNone(isMyProfile);
  });

  // Regression guard for the account-switch bug: clearSession() (logout) must wipe the user-scoped
  // account preferences (emoji recents — no server copy) so a second account on the
  // same browser never sees the previous one's, while leaving device-level preferences (theme, language,
  // list-width, device_id) intact. The DB-layer in-memory caches are reset by each repo's own
  // session-end effect (watching sessionProfile) — covered in their specs.
  it('clearSession() clears account preferences but keeps device preferences', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    svc.sessionProfile.set(profile({ id: 1 }).data);
    await preferences.set('account:1', 'soms.chat.emojiRecents', ['😀']);
    await preferences.set('device', 'theme', 'dark');
    await svc.clearSession();
    expect(svc.sessionProfile()).toBeUndefined();
    expect(
      await preferences.get('account:1', 'soms.chat.emojiRecents'),
    ).toBeUndefined();
    expect(await preferences.get('device', 'theme')).toBe('dark');
    await preferences.remove('device', 'theme');
  });

  it('keeps the revoke route but sends only the P2P thread id', async () => {
    const result = firstValueFrom(svc.revokeRelationship({ threadId: 12 }));
    const request = httpMock.expectOne(
      (req) =>
        req.method === 'POST' && req.url.endsWith('/relationship/revoke'),
    );
    expect(request.request.body).toEqual({ threadId: 12 });
    request.flush({ code: 0, message: 'ok', data: { status: 'OK' } });
    expect(await result).toEqual({
      code: 0,
      message: 'ok',
      data: { status: 'OK' },
    });
  });

  it('derives the friend-request badge from the synchronized read watermark', async () => {
    expect(svc.friendReqBadge()).toBe(false);

    svc.applyRelationshipRequestHead({
      requestEndId: '20',
      requestReadId: '0',
    });
    expect(svc.friendReqBadge()).toBe(true);

    svc.sessionId.set(11);
    const marked = svc.markRelationshipRequestsRead('20');
    httpMock
      .expectOne(
        (req) =>
          req.method === 'POST' &&
          req.url.endsWith('/relationship/requests/read') &&
          (req.body as { requestReadId: string }).requestReadId === '20',
      )
      .flush({ code: 0, data: { requestEndId: '20', requestReadId: '20' } });
    await marked;
    expect(svc.friendReqBadge()).toBe(false);

    svc.applyRelationshipRequestHead({
      requestEndId: '21',
      requestReadId: '20',
    });
    expect(svc.friendReqBadge()).toBe(true);
  });

  it('publishes the optimistic read only after it is durable and submits afterwards', async () => {
    svc.applyRelationshipRequestHead({
      requestEndId: '20',
      requestReadId: '0',
    });
    svc.sessionId.set(11);
    const webdbStub = TestBed.inject(WebdbService) as unknown as {
      advanceIntentRequestRead: ReturnType<typeof vi.fn>;
    };
    let persist!: (state: unknown) => void;
    webdbStub.advanceIntentRequestRead.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          persist = resolve;
        }),
    );
    const observed = svc.observeIncomingRequestPage({
      requestEndId: '20',
      requestReadId: '0',
    });
    await Promise.resolve();
    // Not durable yet: no optimistic publication and no server submission.
    expect(svc.friendReqBadge()).toBe(true);
    httpMock.expectNone((req) =>
      req.url.endsWith('/relationship/requests/read'),
    );
    persist({ intentRequestOptimisticReadId: '20' });
    await vi.waitFor(() => expect(svc.friendReqBadge()).toBe(false));
    httpMock
      .expectOne((req) => req.url.endsWith('/relationship/requests/read'))
      .flush({ code: 0, data: { requestEndId: '20', requestReadId: '20' } });
    await observed;
    expect(webdbStub.advanceIntentRequestRead).toHaveBeenCalledWith('20');
  });

  it('retires the optimistic target once a confirmed read covers it', async () => {
    svc.applyRelationshipRequestHead({
      requestEndId: '20',
      requestReadId: '0',
    });
    const webdbStub = TestBed.inject(WebdbService) as unknown as {
      advanceIntentRequestRead: ReturnType<typeof vi.fn>;
    };
    webdbStub.advanceIntentRequestRead.mockResolvedValueOnce({
      intentRequestOptimisticReadId: '20',
    });
    svc.sessionId.set(11);
    const observed = svc.observeIncomingRequestPage({
      requestEndId: '20',
      requestReadId: '0',
    });
    await vi.waitFor(() => expect(svc.friendReqBadge()).toBe(false));
    // A partial confirmation below the optimistic target keeps the badge suppressed.
    httpMock
      .expectOne((req) => req.url.endsWith('/relationship/requests/read'))
      .flush({ code: 0, data: { requestEndId: '20', requestReadId: '19' } });
    await observed;
    expect(svc.friendReqBadge()).toBe(false);
    // A confirmed read covering the target retires it: newer end shows again.
    svc.applyRelationshipRequestHead({
      requestEndId: '21',
      requestReadId: '20',
    });
    expect(svc.friendReqBadge()).toBe(true);
  });
});

describe('UserService session lifecycle (establishSession / restoreWebdb / clearSession)', () => {
  let reload: Mock;
  let svc: UserService;
  let httpMock: HttpTestingController;
  let webdb: {
    openForUser: Mock;
    openExistingForUser: Mock;
    recreateForUser: Mock;
    closeAndDelete: Mock;
    readAccountState: Mock;
    writeSelfProfile: Mock;
    writeComposerDrafts: Mock;
    advanceIntentRequestRead: Mock;
  };

  function accountStateBase() {
    return {
      schemaVersion: 1,
      selfProfile: null,
      selfIdentity: null,
      composerDrafts: [],
      threadFeedCursor: null,
      stateFeedId: null,
      stateFeedFullThrough: null,
      profileNamespaceChangeEndId: null,
      intentRequestEndId: null,
      intentRequestReadId: null,
      intentRequestOptimisticReadId: null,
    };
  }

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(withXhr()),
        provideHttpClientTesting(),
        UserService,
        {
          provide: WebdbService,
          useValue: {
            openForUser: vi
              .fn()
              .mockName('openForUser')
              .mockResolvedValue(undefined),
            openExistingForUser: vi
              .fn()
              .mockName('openExistingForUser')
              .mockResolvedValue(undefined),
            recreateForUser: vi
              .fn()
              .mockName('recreateForUser')
              .mockResolvedValue(undefined),
            closeAndDelete: vi
              .fn()
              .mockName('closeAndDelete')
              .mockResolvedValue(undefined),
            readAccountState: vi
              .fn()
              .mockName('readAccountState')
              .mockResolvedValue({
                schemaVersion: 1,
                selfProfile: {
                  id: 1,
                  profileRev: 0,
                  isGroup: false,
                  account: 'me',
                  namespaceId: 0,
                  isDeleted: false,
                },
                selfIdentity: null,
                composerDrafts: [],
                threadFeedCursor: null,
                stateFeedId: null,
                stateFeedFullThrough: null,
                profileNamespaceChangeEndId: null,
                intentRequestEndId: null,
                intentRequestReadId: null,
                intentRequestOptimisticReadId: null,
              }),
            writeSelfProfile: vi
              .fn()
              .mockName('writeSelfProfile')
              .mockResolvedValue(undefined),
            writeComposerDrafts: vi
              .fn()
              .mockName('writeComposerDrafts')
              .mockResolvedValue(undefined),
            advanceIntentRequestRead: vi
              .fn()
              .mockName('advanceIntentRequestRead')
              .mockResolvedValue(undefined),
          },
        },
        {
          provide: ProfileRepository,
          useValue: {
            resolve: vi.fn().mockReturnValue(
              of({
                name: 'A',
                bio: '',
                avatarDigest: null,
                avatarBlob: null,
              }),
            ),
          },
        },
      ],
    });
    reload = vi.fn();
    TestBed.overrideProvider(CACHE_REBUILD_RELOAD, { useValue: reload });
    svc = TestBed.inject(UserService);
    httpMock = TestBed.inject(HttpTestingController);
    webdb = TestBed.inject(WebdbService) as unknown as typeof webdb;
    await TestBed.inject(PreferenceStore).remove('device', 'soms.lastUserId');
    await TestBed.inject(PreferenceStore).remove(
      'account:1',
      'soms.cacheRebuild',
    );
    await TestBed.inject(PreferenceStore).remove(
      'account:7',
      'soms.cacheRebuild',
    );
  });

  afterEach(() => {
    httpMock.verify();
    void TestBed.inject(PreferenceStore).remove('device', 'soms.lastUserId');
  });

  it('establishSession opens the per-user IDB on userId + sets sessionUserId + persists lastUserId', async () => {
    await svc.establishSession(1, 0, 11);
    expect(svc.sessionId()).toBe(11);
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBe(1);
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBe(1);
  });

  it('loads and caches a fresh revision-zero account after HELLO without resolving a profile', async () => {
    webdb.readAccountState.mockResolvedValue(accountStateBase());
    await svc.establishSession(3, 0, 13);
    const account = {
      id: 3,
      account: 'qifaai2',
      namespaceId: 0,
      profileRev: 0,
      isGroup: false,
      isDeleted: false,
    };
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush({
      code: 0,
      data: account,
    });
    const expected = { ...account, name: 'qifaai2', bio: '' };
    await vi.waitFor(() => expect(svc.sessionProfile()).toEqual(expected));
    expect(webdb.writeSelfProfile).toHaveBeenCalledWith(account);
    expect(TestBed.inject(ProfileRepository).resolve).not.toHaveBeenCalled();

    svc.resetSessionState();
    webdb.readAccountState.mockResolvedValue({
      ...accountStateBase(),
      selfProfile: account,
    });
    await svc.establishSession(3, 0, 14);
    await vi.waitFor(() => expect(svc.sessionProfile()).toEqual(expected));
    httpMock.expectNone(isMyProfile);
    expect(TestBed.inject(ProfileRepository).resolve).not.toHaveBeenCalled();
  });

  it('establishes a session without scheduling any local request garbage collection', async () => {
    await svc.establishSession(1, 0, 11);
    expect(svc.sessionId()).toBe(11);
  });

  it('restores the synchronized request head from the account state', async () => {
    webdb.readAccountState.mockImplementation(async () => ({
      schemaVersion: 1,
      selfProfile: {
        id: 1,
        profileRev: 0,
        name: 'A',
        avatar: '',
        bio: '',
        isGroup: false,
        account: 'me',
        namespaceId: 0,
        isDeleted: false,
      },
      selfIdentity: null,
      composerDrafts: [],
      threadFeedCursor: null,
      stateFeedId: null,
      stateFeedFullThrough: null,
      profileNamespaceChangeEndId: null,
      intentRequestEndId: '12',
      intentRequestReadId: '9',
      intentRequestOptimisticReadId: null,
    }));

    await svc.establishSession(1, 0, 11);

    expect(svc.relationshipRequestHead()).toEqual({
      requestEndId: '12',
      requestReadId: '9',
    });
    expect(svc.friendReqBadge()).toBe(true);
  });

  it('seeds the optimistic read watermark from durable state on HELLO establish', async () => {
    webdb.readAccountState.mockResolvedValueOnce({
      ...accountStateBase(),
      intentRequestEndId: '12',
      intentRequestReadId: '9',
      intentRequestOptimisticReadId: '12',
    });

    await svc.establishSession(1, 0, 11);

    expect(svc.friendReqBadge()).toBe(false);
    // Seeding a target beyond the confirmed read also resubmits it durably.
    httpMock
      .expectOne((req) => req.url.endsWith('/relationship/requests/read'))
      .flush({ code: 0, data: { requestEndId: '12', requestReadId: '12' } });
    await vi.waitFor(() => expect(svc.friendReqBadge()).toBe(false));
  });

  it('resubmits a durable unconfirmed read target once the session establishes', async () => {
    webdb.readAccountState.mockResolvedValueOnce({
      ...accountStateBase(),
      intentRequestEndId: '12',
      intentRequestReadId: '9',
      intentRequestOptimisticReadId: '12',
    });

    await svc.establishSession(1, 0, 11);

    const request = httpMock.expectOne((req) =>
      req.url.endsWith('/relationship/requests/read'),
    );
    expect(
      (request.request.body as { requestReadId: string }).requestReadId,
    ).toBe('12');
    request.flush({
      code: 0,
      data: { requestEndId: '12', requestReadId: '12' },
    });
    await vi.waitFor(() => expect(svc.friendReqBadge()).toBe(false));
  });

  it('does not resubmit when the durable target is already confirmed', async () => {
    webdb.readAccountState.mockResolvedValueOnce({
      ...accountStateBase(),
      intentRequestEndId: '12',
      intentRequestReadId: '12',
      intentRequestOptimisticReadId: null,
    });

    await svc.establishSession(1, 0, 11);

    httpMock.expectNone((req) =>
      req.url.endsWith('/relationship/requests/read'),
    );
  });

  it('does not rebuild the database for an invalidated HELLO after an open failure', async () => {
    let rejectOpen!: (error: Error) => void;
    webdb.openExistingForUser.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectOpen = reject;
        }),
    );
    const opening = svc.establishSession(1, 0, 11);
    const rejected = expect(opening).rejects.toThrow(
      'account session expired during HELLO',
    );
    TestBed.inject(SessionLifecycleService).invalidateSession();
    rejectOpen(new Error('closed during logout'));
    await rejected;
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBeNull();
  });

  it('fresh login drops and initializes the cache before strictly opening it', async () => {
    svc.prepareFreshCache();

    await svc.establishSession(1, 0, 11);

    expect(webdb.recreateForUser).toHaveBeenCalledTimes(1);

    expect(webdb.recreateForUser).toHaveBeenCalledWith('1');
    expect(webdb.openExistingForUser).toHaveBeenCalledTimes(1);
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('1');
  });

  it('rebuilds an unreadable cache discovered when HELLO establishes the session', async () => {
    webdb.openExistingForUser.mockRejectedValue(new Error('unreadable cache'));
    await expect(svc.establishSession(1, 0, 11)).resolves.not.toThrow();
    expect(webdb.recreateForUser).toHaveBeenCalledExactlyOnceWith('1');
  });

  it('establishSession is idempotent for the same user on reconnect', async () => {
    await svc.establishSession(1, 0, 11);
    webdb.openExistingForUser.mockClear();
    await svc.establishSession(1, 0, 12);
    expect(svc.sessionId()).toBe(12);
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBe(1);
  });

  it('establishSession on an account switch closes the previous DB + opens the new one', async () => {
    await svc.establishSession(1, 0, 11);
    webdb.closeAndDelete.mockClear();
    webdb.openExistingForUser.mockClear();

    // Switch to user 2: gateSelfProfile cache-misses (cached id:1 ≠ 2) → flush its my-profile fetch.
    const done = svc.establishSession(2, 0, 12);
    (await vi.waitFor(() => httpMock.expectOne(isMyProfile))).flush(
      profile({ id: 2 }),
    );
    await done;

    expect(webdb.closeAndDelete).toHaveBeenCalledWith('1'); // previous user's DB torn down
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('2'); // new user's DB opened
    expect(svc.sessionUserId()).toBe(2);
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBe(2);
  });

  it('clearSession closes the DB + clears sessionUserId + clears lastUserId', async () => {
    await svc.establishSession(1, 0, 11);
    webdb.closeAndDelete.mockClear();

    await svc.clearSession();
    expect(svc.sessionId()).toBeNull();
    expect(webdb.closeAndDelete).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBeNull();
    // clearSession awaits the preference removal before it resolves — no drain needed.
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBeUndefined();
  });

  it('invalidates old work synchronously when a fresh login replaces credentials', () => {
    const lifecycle = TestBed.inject(SessionLifecycleService);
    const previous = lifecycle.capture();
    const ended = vi.fn();
    const subscription = lifecycle.ended$.subscribe(ended);

    svc.prepareFreshCache();

    expect(lifecycle.isCurrent(previous)).toBe(false);
    expect(ended).not.toHaveBeenCalled();
    subscription.unsubscribe();
  });

  it('announces completed cleanup even when the session ended before HELLO', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 1);
    await svc.restoreWebdb();
    expect(svc.sessionUserId()).toBeNull();
    const ended = vi.fn();
    const subscription = TestBed.inject(
      SessionLifecycleService,
    ).ended$.subscribe(ended);
    let finishDeletion!: () => void;
    webdb.closeAndDelete.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDeletion = resolve;
        }),
    );

    const previous = TestBed.inject(SessionLifecycleService).capture();
    const clearing = svc.clearSession();
    expect(previous.signal.aborted).toBe(true);
    expect(ended).not.toHaveBeenCalled();
    finishDeletion();
    await clearing;

    expect(webdb.closeAndDelete).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
    await svc.clearSession();
    expect(ended).toHaveBeenCalledTimes(2);
    subscription.unsubscribe();
  });

  it('keeps the session retryable when durable cache deletion fails', async () => {
    await svc.establishSession(1, 0, 11);
    const ended = vi.fn();
    const subscription = TestBed.inject(
      SessionLifecycleService,
    ).ended$.subscribe(ended);
    webdb.closeAndDelete.mockRejectedValue(new Error('cache busy'));

    const previous = TestBed.inject(SessionLifecycleService).capture();
    await expect(svc.clearSession()).rejects.toThrowError('cache busy');
    expect(previous.signal.aborted).toBe(true);
    expect(svc.sessionUserId()).toBe(1);
    expect(ended).not.toHaveBeenCalled();
    expect(
      await TestBed.inject(PreferenceStore).get('device', 'soms.lastUserId'),
    ).toBe(1);

    webdb.closeAndDelete.mockResolvedValue(undefined);
    const retryScope = TestBed.inject(SessionLifecycleService).capture();
    await svc.clearSession();
    expect(webdb.closeAndDelete).toHaveBeenCalledTimes(2);
    expect(retryScope.signal.aborted).toBe(true);
    expect(svc.sessionUserId()).toBeNull();
    expect(ended).toHaveBeenCalledTimes(1);
    subscription.unsubscribe();
  });

  it('restoreWebdb opens the DB and restores the matching self profile for offline eager paint', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    const cached = {
      id: 7,
      account: 'alice',
      namespaceId: 0,
      profileRev: 1,
      isGroup: false,
      isDeleted: false,
    };
    webdb.readAccountState.mockResolvedValue({
      ...accountStateBase(),
      selfProfile: cached,
    });
    await svc.restoreWebdb();
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('7');
    expect(svc.sessionProfile()).toEqual({
      ...cached,
      name: 'A',
      bio: '',
    });
    expect(TestBed.inject(ProfileRepository).resolve).toHaveBeenCalledWith({
      publisherNamespaceId: 0,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 0, account: 'alice', rev: 1 },
    });
    // sessionUserId is NOT set by restoreWebdb — it stays HELLO-driven (establishSession owns it on HELLO).
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoreWebdb rebuilds any invalid cache without ending the session', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.openExistingForUser.mockRejectedValue(
      new LocalCacheVersionMismatchError('soms-webdb-u7'),
    );
    webdb.readAccountState.mockResolvedValue(accountStateBase());
    await svc.restoreWebdb();
    expect(webdb.recreateForUser).toHaveBeenCalledExactlyOnceWith('7');
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoreWebdb also rebuilds a missing or unreadable cache', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.openExistingForUser.mockRejectedValue(new Error('unreadable cache'));
    webdb.readAccountState.mockResolvedValue(accountStateBase());
    await svc.restoreWebdb();
    expect(webdb.recreateForUser).toHaveBeenCalledExactlyOnceWith('7');
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoreWebdb ignores a self profile belonging to a different IDB partition owner', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.readAccountState.mockResolvedValue({
      ...accountStateBase(),
      selfProfile: profile({ id: 8 }).data,
    });
    await svc.restoreWebdb();
    expect(svc.sessionProfile()).toBeUndefined();
  });

  it('restoreWebdb is a no-op when no userId was persisted (first-ever launch)', async () => {
    await svc.restoreWebdb();
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
  });

  it('defers missing-account recovery to normal HELLO initialization', async () => {
    await svc.requestCacheRebuild();
    expect(reload).not.toHaveBeenCalled();
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
  });

  it('allows another automatic recovery only after a new login', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.set('account:1', 'soms.cacheRebuild', 'attempted');
    svc.prepareFreshCache();
    await svc.establishSession(1, 0, 11);
    expect(
      await preferences.get('account:1', 'soms.cacheRebuild'),
    ).toBeUndefined();
    await svc.requestCacheRebuild();
    expect(reload).toHaveBeenCalledOnce();
    expect(await preferences.get('account:1', 'soms.cacheRebuild')).toBe(
      'pending',
    );
  });

  it('does not retry a failed rebuild when HELLO arrives after startup', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.set('device', 'soms.lastUserId', 7);
    await preferences.set('account:7', 'soms.cacheRebuild', 'attempted');
    const failure = new Error('database still unavailable');
    webdb.openExistingForUser.mockRejectedValue(failure);
    await svc.restoreWebdb();
    await expect(svc.establishSession(7, 0, 17)).rejects.toBe(failure);
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBeNull();
  });

  it('coalesces recovery requests and rebuilds on the next boot without clearing the session', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.set('device', 'soms.lastUserId', 7);
    await svc.restoreWebdb();
    const ended = vi.fn();
    const subscription = TestBed.inject(
      SessionLifecycleService,
    ).ended$.subscribe(ended);
    await Promise.all([svc.requestCacheRebuild(), svc.requestCacheRebuild()]);
    expect(reload).toHaveBeenCalledOnce();
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(await preferences.get('account:7', 'soms.cacheRebuild')).toBe(
      'pending',
    );

    const nextBoot = TestBed.runInInjectionContext(
      () => new UserService(TestBed.inject(HttpClient)),
    );
    await nextBoot.restoreWebdb();
    expect(webdb.recreateForUser).toHaveBeenCalledOnce();
    expect(webdb.recreateForUser).toHaveBeenCalledWith('7');
    expect(await preferences.get('account:7', 'soms.cacheRebuild')).toBe(
      'attempted',
    );
    expect(await preferences.get('device', 'soms.lastUserId')).toBe(7);
    expect(nextBoot.stateFeedCursor()).toBeUndefined();
    expect(ended).not.toHaveBeenCalled();
    await nextBoot.requestCacheRebuild();
    expect(reload).toHaveBeenCalledOnce();
    subscription.unsubscribe();
  });

  it('warns and stops if the one automatic rebuild fails', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.set('device', 'soms.lastUserId', 7);
    await preferences.set('account:7', 'soms.cacheRebuild', 'pending');
    const failure = new Error('storage unavailable');
    webdb.recreateForUser.mockRejectedValue(failure);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(svc.restoreWebdb()).resolves.toBeUndefined();
    await svc.requestCacheRebuild();
    expect(webdb.recreateForUser).toHaveBeenCalledOnce();
    expect(reload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[cache-recovery] account cache rebuild unavailable',
      failure,
    );
    expect(await preferences.get('account:7', 'soms.cacheRebuild')).toBe(
      'attempted',
    );
  });

  it('rebuilds after cached profile reading fails, not only after opening fails', async () => {
    await TestBed.inject(PreferenceStore).set('device', 'soms.lastUserId', 7);
    webdb.readAccountState.mockRejectedValueOnce(new Error('corrupt profile'));
    await expect(svc.restoreWebdb()).resolves.toBeUndefined();
    expect(webdb.recreateForUser).toHaveBeenCalledOnce();
  });

  it('warns without rejecting if the recovery marker cannot be saved', async () => {
    const preferences = TestBed.inject(PreferenceStore);
    await preferences.set('device', 'soms.lastUserId', 7);
    await svc.restoreWebdb();
    const failure = new Error('preferences unavailable');
    vi.spyOn(preferences, 'set').mockRejectedValueOnce(failure);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(svc.requestCacheRebuild()).resolves.toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[cache-recovery] could not schedule cache rebuild',
      failure,
    );
  });
});
