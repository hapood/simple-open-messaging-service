import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Subject } from 'rxjs';
import { MemberProfileRepository } from './member-profile-store.service';
import { WebdbService, type ProfileWake } from './webdb.service';
import { WebdbStorage } from './webdb-storage';
import { prepareTestSessionCache } from './session/session-cache.test-helper';
import { SessionLifecycleService } from './session-lifecycle.service';

describe('MemberProfileRepository invalidation', () => {
  it('refreshes queried rosters after resolution, including empty name searches', async () => {
    const wakes = new Subject<ProfileWake>();
    const ended = new Subject<void>();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: WebdbService,
          useValue: { profileWake$: wakes },
        },
        { provide: SessionLifecycleService, useValue: { ended$: ended } },
      ],
    });
    const repo = TestBed.inject(MemberProfileRepository);
    const changed = vi.fn();
    repo.changed$.subscribe(changed);
    const http = TestBed.inject(HttpTestingController);
    for (const threadId of [42, 43]) {
      const pending = repo.queryPage(threadId, {
        take: 50,
        ...(threadId === 42 ? { search: 'Alice New' } : {}),
      });
      http.expectOne('/api/v1/group/members').flush({
        code: 0,
        data: { items: [], nextCursor: null },
      });
      expect(await pending).toEqual([]);
    }
    http.verify();
    const key = {
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      account: 'alice',
      rev: 4,
    };
    wakes.next({ event: 'PROFILE_UNAVAILABLE', key, reason: 'PENDING' });
    expect(changed).not.toHaveBeenCalled();
    wakes.next({ event: 'PROFILE_AVAILABLE', key });
    expect(changed).toHaveBeenCalledWith([42, 43]);
    ended.next();
    changed.mockClear();
    wakes.next({ event: 'PROFILE_AVAILABLE', key });
    expect(changed).not.toHaveBeenCalled();
  });

  it('queries the server envelope with opaque cursors and preserves publisher-scoped profile identities', async () => {
    const getProfile = vi
      .fn()
      .mockResolvedValueOnce({
        profileRev: 4,
        name: 'Alice New',
        bio: 'About',
      })
      .mockResolvedValue(undefined);
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        {
          provide: WebdbService,
          useValue: { profileWake$: new Subject(), getProfile },
        },
        {
          provide: SessionLifecycleService,
          useValue: { ended$: new Subject() },
        },
      ],
    });
    const repo = TestBed.inject(MemberProfileRepository);
    const http = TestBed.inject(HttpTestingController);
    const pending = repo.queryRosterPage(42, {
      take: 1,
      search: 'Alice',
      exclude: { account: 'self', namespaceId: 0 },
    });
    const request = http.expectOne('/api/v1/group/members');
    expect(request.request.method).toBe('POST');
    expect(request.request.body).toEqual({
      threadId: 42,
      take: 1,
      search: 'Alice',
      excludeSelf: true,
    });
    request.flush({
      code: 0,
      data: {
        items: [
          {
            account: 'alice',
            publisherNamespaceId: 7,
            profileNamespaceId: 2,
            profileRev: 4,
            role: 'ADMIN',
          },
        ],
        nextCursor: 'opaque-server-cursor',
      },
    });
    const page = await pending;
    expect(page.nextCursor).toBe('opaque-server-cursor');
    expect(page.items).toEqual([
      expect.objectContaining({
        account: 'alice',
        publisherNamespaceId: 7,
        namespaceId: 2,
        name: 'Alice New',
        bio: 'About',
        profileRev: 4,
        profileResolved: true,
        role: 'ADMIN',
      }),
    ]);
    expect(getProfile).toHaveBeenCalledWith({
      publisherNamespaceId: 7,
      lookup: 'ACCOUNT_PROFILE',
      target: { profileNamespaceId: 2, account: 'alice', rev: 4 },
    });
    const next = repo.queryRosterPage(42, {
      take: 1,
      search: 'Alice',
      exclude: { account: 'self', namespaceId: 0 },
      cursor: page.nextCursor,
    });
    const nextRequest = http.expectOne('/api/v1/group/members');
    expect(nextRequest.request.body).toEqual({
      threadId: 42,
      take: 1,
      search: 'Alice',
      excludeSelf: true,
      cursor: 'opaque-server-cursor',
    });
    nextRequest.flush({
      code: 0,
      data: {
        items: [
          {
            account: 'alice-remote',
            publisherNamespaceId: 7,
            profileNamespaceId: 0,
            profileRev: 5,
            role: 'OWNER',
          },
        ],
        nextCursor: null,
      },
    });
    expect(await next).toEqual({
      items: [
        expect.objectContaining({
          name: 'alice-remote',
          bio: '',
          publisherNamespaceId: 7,
          namespaceId: 0,
          profileResolved: false,
          isOwner: true,
        }),
      ],
      nextCursor: null,
    });
    http.verify();
  });

  it('rejects business errors instead of treating them as empty rosters', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: WebdbService, useValue: { profileWake$: new Subject() } },
        {
          provide: SessionLifecycleService,
          useValue: { ended$: new Subject() },
        },
      ],
    });
    const pending = TestBed.inject(MemberProfileRepository).queryPage(42, {
      take: 50,
    });
    const rejected = expect(pending).rejects.toThrow(
      'group members are not ready',
    );
    const http = TestBed.inject(HttpTestingController);
    http
      .expectOne('/api/v1/group/members')
      .flush({ code: 1, message: 'group members are not ready' });
    await rejected;
    http.verify();
  });

  it('forwards the worker commit event without notifying again for READY or cache hits', async () => {
    const profile = {
      account: 'alice',
      publisherNamespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 4,
      name: 'Alice New',
      bio: '',
      avatar: '',
    };
    let first = true;
    const worker = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      postMessage(request: { id: number }) {
        queueMicrotask(() => {
          if (first) {
            first = false;
            worker.onmessage?.({
              data: {
                type: 'profile-wake',
                wake: {
                  event: 'PROFILE_AVAILABLE',
                  key: {
                    publisherNamespaceId: 0,
                    profileNamespaceId: 0,
                    account: 'alice',
                    rev: 4,
                  },
                },
              },
            } as MessageEvent);
          }
          worker.onmessage?.({
            data: {
              id: request.id,
              ok: true,
              result: { status: 'READY', profile },
            },
          } as MessageEvent);
        });
      },
      terminate() {},
    };
    const db = new WebdbStorage(
      () => worker as unknown as Worker,
      new SessionLifecycleService(),
    );
    db.bindSessionCache(await prepareTestSessionCache());
    await db.openForUser('994202');
    const notified = vi.fn();
    db.profileWake$.subscribe(notified);
    try {
      const demand = {
        publisherNamespaceId: 0,
        lookup: 'ACCOUNT_PROFILE' as const,
        target: { profileNamespaceId: 0, account: 'alice', rev: 4 },
      };
      await db.resolveProfileDemand(demand);
      expect(notified).toHaveBeenCalledTimes(1);
      await db.resolveProfileDemand(demand);
      await db.applyProfileEvent('PROFILE_AVAILABLE', {
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        account: 'alice',
        rev: 4,
      });
      expect(notified).toHaveBeenCalledTimes(1);
    } finally {
      await db.closeAndDelete('994202');
    }
  });

  it('announces a committed snapshot only after readers can see it', async () => {
    const db = new WebdbStorage(() => null, new SessionLifecycleService());
    db.bindSessionCache(await prepareTestSessionCache());
    await db.openForUser('994201');
    const reads: Promise<unknown>[] = [];
    db.profileWake$.subscribe((wake) => {
      if (wake.event === 'PROFILE_AVAILABLE')
        reads.push(
          db.getProfile({
            publisherNamespaceId: wake.key.publisherNamespaceId,
            lookup: 'ACCOUNT_PROFILE',
            target: {
              profileNamespaceId: wake.key.profileNamespaceId,
              account: wake.key.account,
              rev: wake.key.rev,
            },
          }),
        );
    });
    try {
      await db.commitResolvedProfile({
        account: 'alice',
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        rev: 4,
        name: 'Alice New',
        bio: '',
        avatarBase64: null,
      });
      expect(reads).toHaveLength(1);
      expect(await reads[0]).toMatchObject({
        name: 'Alice New',
        profileRev: 4,
      });
      await db.commitResolvedProfile({
        account: 'alice',
        publisherNamespaceId: 0,
        profileNamespaceId: 0,
        rev: 4,
        name: 'Alice New',
        bio: '',
        avatarBase64: null,
      });
      expect(reads).toHaveLength(1);
      await expect(
        db.commitResolvedProfile({
          account: 'alice',
          publisherNamespaceId: 0,
          profileNamespaceId: 0,
          rev: 4,
          name: 'Conflicting',
          bio: '',
          avatarBase64: null,
        }),
      ).rejects.toThrow('conflicting cached profile revision');
      expect(reads).toHaveLength(1);
    } finally {
      await db.closeAndDelete('994201');
    }
  });
});
