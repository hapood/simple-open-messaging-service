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
import { firstValueFrom, of, Subject, throwError } from 'rxjs';
import { DatabaseRestorationError } from './session/database-restoration-error';
import { SessionSupersededError } from './session/session-identity';
import { UserService } from './user.service';
import { REQUEST_SCOPE, RequestScope } from '../request-context';
import {
  LocalCacheCorruptionError,
  LocalCacheVersionMismatchError,
  WebdbService,
} from './webdb.service';
import {
  ProfileRepository,
  type ResolvedProfile,
} from './profile-store.service';
import { User } from './model';
import { AppStateStorage } from './preference-storage';
import { ThreadSendOutbox } from './thread-send-outbox.service';
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
        {
          provide: ThreadSendOutbox,
          useValue: { restore: vi.fn().mockResolvedValue(undefined) },
        },
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

describe('UserService session lifecycle (establishSession / restoreWebdb / resetSessionState)', () => {
  let svc: UserService;
  let httpMock: HttpTestingController;
  let webdb: {
    openForUser: Mock;
    openExistingForUser: Mock;
    recreateForUser: Mock;
    closeAndDelete: Mock;
    readAccountState: Mock;
    readCachedSelfProfile: Mock;
    recreateSessionCache: Mock;
    writeSelfProfile: Mock;
    writeComposerDrafts: Mock;
    advanceIntentRequestRead: Mock;
  };

  function accountStateBase() {
    return {
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
          provide: ThreadSendOutbox,
          useValue: { restore: vi.fn().mockResolvedValue(undefined) },
        },
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
    svc = TestBed.inject(UserService);
    httpMock = TestBed.inject(HttpTestingController);
    webdb = TestBed.inject(WebdbService) as unknown as typeof webdb;
    webdb.readCachedSelfProfile = vi.fn(
      async () => (await webdb.readAccountState()).selfProfile,
    );
    webdb.recreateSessionCache = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    httpMock.verify();
  });

  it('establishSession binds the session cache to the HELLO user and session IDs', async () => {
    await svc.establishSession(1, 0, 11);
    expect(svc.sessionId()).toBe(11);
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('1');
    expect(svc.sessionUserId()).toBe(1);
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

  it('does not rebuild a corrupted cache discovered when HELLO establishes the session', async () => {
    const failure = new LocalCacheCorruptionError(
      'unreadable local cache: soms-session',
    );
    webdb.openExistingForUser.mockRejectedValueOnce(failure);
    await expect(svc.establishSession(1, 0, 11)).rejects.toEqual(
      new DatabaseRestorationError(failure),
    );
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBeNull();
  });

  it('does not rebuild the cache when HELLO session open fails for a non-corruption reason', async () => {
    const failure = new Error('storage blocked');
    webdb.openExistingForUser.mockRejectedValue(failure);
    await expect(svc.establishSession(1, 0, 11)).rejects.toBe(failure);
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
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
  });

  it('resetSessionState clears in-memory identity and announces completion without deleting the cache', async () => {
    await svc.establishSession(1, 0, 11);
    await vi.waitFor(() => expect(svc.sessionProfile()).toBeDefined());
    svc.seedStateFeedCursor(7);
    svc.applyRelationshipRequestHead({
      requestEndId: '12',
      requestReadId: '9',
    });
    const ended = vi.fn();
    const subscription = TestBed.inject(
      SessionLifecycleService,
    ).ended$.subscribe(ended);
    webdb.closeAndDelete.mockClear();

    svc.resetSessionState();

    expect(svc.sessionId()).toBeNull();
    expect(svc.sessionUserId()).toBeNull();
    expect(svc.sessionProfile()).toBeUndefined();
    expect(svc.stateFeedCursor()).toBeUndefined();
    expect(svc.relationshipRequestHead()).toBeUndefined();
    expect(svc.friendReqBadge()).toBe(false);
    expect(webdb.closeAndDelete).not.toHaveBeenCalled();
    expect(ended).toHaveBeenCalledOnce();
    subscription.unsubscribe();
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

  it('restoreWebdb opens the local cache without resolving profiles over the network', async () => {
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
    await svc.restoreWebdb(new AbortController().signal);
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('7');
    expect(svc.sessionProfile()).toBeUndefined();
    expect(TestBed.inject(ProfileRepository).resolve).not.toHaveBeenCalled();
    expect(
      TestBed.inject(ThreadSendOutbox).restore,
    ).toHaveBeenCalledExactlyOnceWith();
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(webdb.recreateSessionCache).not.toHaveBeenCalled();
    // sessionUserId is NOT set by restoreWebdb — it stays HELLO-driven (establishSession owns it on HELLO).
    expect(svc.sessionUserId()).toBeNull();
  });

  it('restoration and HELLO bind the same real owner without deleting its cache', async () => {
    await svc.restoreWebdb(new AbortController().signal);
    expect(svc.sessionUserId()).toBeNull();
    expect(svc.sessionId()).toBeNull();
    expect(webdb.openExistingForUser).toHaveBeenCalledExactlyOnceWith('1');
    await svc.establishSession(1, 0, 11);
    expect(webdb.openExistingForUser.mock.calls).toEqual([['1'], ['1']]);
    expect(webdb.closeAndDelete).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBe(1);
    expect(svc.sessionId()).toBe(11);
  });

  it('restores native storage using only the real cached numeric owner', async () => {
    const nativeWindow = window as unknown as {
      __TAURI_INTERNALS__?: unknown;
      __TAURI__?: unknown;
    };
    const internals = nativeWindow.__TAURI_INTERNALS__;
    const tauri = nativeWindow.__TAURI__;
    const invoke = vi
      .fn()
      .mockRejectedValue(new Error('unexpected native command'));
    nativeWindow.__TAURI_INTERNALS__ = {};
    nativeWindow.__TAURI__ = { core: { invoke } };
    vi.spyOn(AppStateStorage.prototype, 'get').mockResolvedValue(undefined);
    webdb.readCachedSelfProfile.mockResolvedValue(
      profile({ id: 42, profileRev: 0 }).data,
    );
    try {
      await svc.restoreWebdb(new AbortController().signal);
      expect(webdb.openExistingForUser).toHaveBeenCalledExactlyOnceWith('42');
      expect(webdb.writeSelfProfile).not.toHaveBeenCalled();
      expect(TestBed.inject(ProfileRepository).resolve).not.toHaveBeenCalled();
      expect(svc.sessionProfile()).toBeUndefined();
      expect(svc.sessionUserId()).toBeNull();
      expect(invoke).not.toHaveBeenCalled();
    } finally {
      if (internals === undefined) delete nativeWindow.__TAURI_INTERNALS__;
      else nativeWindow.__TAURI_INTERNALS__ = internals;
      if (tauri === undefined) delete nativeWindow.__TAURI__;
      else nativeWindow.__TAURI__ = tauri;
    }
  });

  it('rejects cancellation while discovering cached identity without opening or rebuilding', async () => {
    let finish!: (value: unknown) => void;
    webdb.readCachedSelfProfile.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const restoring = svc.restoreWebdb(controller.signal);
    const rejected = expect(restoring).rejects.toThrow(
      'The local login session is no longer active',
    );
    await vi.waitFor(() =>
      expect(webdb.readCachedSelfProfile).toHaveBeenCalled(),
    );
    controller.abort();
    finish(profile({ id: 7 }).data);
    await rejected;
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
    expect(webdb.recreateSessionCache).not.toHaveBeenCalled();
    expect(svc.sessionProfile()).toBeUndefined();
  });

  it('does not resolve profiles while restoring a cancelled session', async () => {
    webdb.readCachedSelfProfile.mockResolvedValue(profile({ id: 7 }).data);
    const controller = new AbortController();
    controller.abort();
    await expect(svc.restoreWebdb(controller.signal)).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
    expect(TestBed.inject(ProfileRepository).resolve).not.toHaveBeenCalled();
    expect(webdb.writeSelfProfile).not.toHaveBeenCalled();
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
  });

  it('rejects restoration when the session is invalidated without aborting the signal', async () => {
    webdb.readCachedSelfProfile.mockImplementationOnce(async () => {
      TestBed.inject(SessionLifecycleService).invalidateSession();
      return profile({ id: 7 }).data;
    });
    await expect(
      svc.restoreWebdb(new AbortController().signal),
    ).rejects.toBeInstanceOf(SessionSupersededError);
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
    expect(webdb.recreateSessionCache).not.toHaveBeenCalled();
    expect(svc.sessionProfile()).toBeUndefined();
  });

  it('tags an invalid cache for owner recovery without inventing an account identity', async () => {
    const failure = new LocalCacheVersionMismatchError('soms-session');
    webdb.readCachedSelfProfile.mockRejectedValue(failure);
    await expect(
      svc.restoreWebdb(new AbortController().signal),
    ).rejects.toEqual(new DatabaseRestorationError(failure));
    expect(webdb.recreateSessionCache).not.toHaveBeenCalled();
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBeNull();
  });

  it('does not authorize deletion for an unclassified cache open failure', async () => {
    const failure = new Error('unreadable cache');
    webdb.openExistingForUser.mockRejectedValue(failure);
    await expect(
      svc.restoreWebdb(new AbortController().signal),
    ).rejects.toBe(failure);
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(webdb.recreateSessionCache).not.toHaveBeenCalled();
    expect(TestBed.inject(ThreadSendOutbox).restore).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBeNull();
  });

  it.each([0, -1, NaN, 1.5])(
    'restoreWebdb never binds an invalid cached numeric identity %s',
    async (id) => {
      webdb.readCachedSelfProfile.mockResolvedValue(profile({ id }).data);
      await expect(
        svc.restoreWebdb(new AbortController().signal),
      ).rejects.toBeInstanceOf(DatabaseRestorationError);
      expect(svc.sessionProfile()).toBeUndefined();
      expect(webdb.openExistingForUser).not.toHaveBeenCalled();
      expect(webdb.recreateForUser).not.toHaveBeenCalled();
      expect(webdb.recreateSessionCache).not.toHaveBeenCalled();
    },
  );

  it('restoreWebdb leaves an empty cache unbound until HELLO identifies the user', async () => {
    webdb.readCachedSelfProfile.mockResolvedValue(null);
    await svc.restoreWebdb(new AbortController().signal);
    expect(webdb.openExistingForUser).not.toHaveBeenCalled();
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(TestBed.inject(ThreadSendOutbox).restore).not.toHaveBeenCalled();
    expect(svc.sessionProfile()).toBeUndefined();
    expect(svc.sessionId()).toBeNull();
    await svc.establishSession(1, 0, 11);
    expect(webdb.openExistingForUser).toHaveBeenCalledExactlyOnceWith('1');
    expect(svc.sessionId()).toBe(11);
  });

  it('does not rebuild when HELLO arrives after an unclassified open failure', async () => {
    const failure = new Error('database still unavailable');
    webdb.openExistingForUser.mockRejectedValue(failure);
    await expect(
      svc.restoreWebdb(new AbortController().signal),
    ).rejects.toBe(failure);
    await expect(svc.establishSession(7, 0, 17)).rejects.toBe(failure);
    expect(webdb.recreateForUser).not.toHaveBeenCalled();
    expect(svc.sessionUserId()).toBeNull();
  });

  it.each(['cached profile', 'outbox'])(
    'leaves %s storage failures unchanged without recreating the cache',
    async (stage) => {
      const failure = new Error('storage unavailable');
      if (stage === 'cached profile')
        webdb.readCachedSelfProfile.mockRejectedValueOnce(failure);
      else
        vi.mocked(
          TestBed.inject(ThreadSendOutbox).restore,
        ).mockRejectedValueOnce(failure);
      await expect(
        svc.restoreWebdb(new AbortController().signal),
      ).rejects.toBe(failure);
      expect(webdb.recreateSessionCache).not.toHaveBeenCalled();
      expect(webdb.recreateForUser).not.toHaveBeenCalled();
    },
  );

  it('does not start profile resolution during local restoration', async () => {
    webdb.readCachedSelfProfile.mockResolvedValue(profile({ id: 7 }).data);
    await svc.restoreWebdb(new AbortController().signal);
    expect(TestBed.inject(ProfileRepository).resolve).not.toHaveBeenCalled();
    expect(webdb.writeSelfProfile).not.toHaveBeenCalled();
    expect(webdb.openExistingForUser).toHaveBeenCalledWith('7');
    expect(TestBed.inject(ThreadSendOutbox).restore).toHaveBeenCalledOnce();
    expect(svc.sessionProfile()).toBeUndefined();
  });

  it('rejects an already-aborted restoration before reading storage', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(svc.restoreWebdb(controller.signal)).rejects.toBeInstanceOf(
      SessionSupersededError,
    );
    expect(webdb.readCachedSelfProfile).not.toHaveBeenCalled();
    expect(webdb.recreateSessionCache).not.toHaveBeenCalled();
  });
});
