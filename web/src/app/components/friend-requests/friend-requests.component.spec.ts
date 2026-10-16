import { RequestProjectionStatus } from '../../../../../shared/request-projection-status';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { RouteService } from '../../services/route.service';
import type { UserRef } from '../../services/model';
import {
  FederatedResolveError,
  FriendIntentPage,
  UserService,
  User,
} from '../../services/user.service';
import {
  AddTabStatus,
  FriendRequestsComponent,
} from './friend-requests.component';

describe('FriendRequestsComponent federated search progress', () => {
  it.each(['bob', '!team'])('keeps the fixed card address for %s across retry and cancellation', (account) => {
    const userService = {
      sessionProfile: () => undefined,
      resolveFederatedUser: vi.fn().mockReturnValue(new Subject()),
    };
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        { provide: TranslocoService, useValue: { translate: (key: string) => key } },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const fixture = TestBed.createComponent(FriendRequestsComponent);
    fixture.componentRef.setInput('initialAddress', {
      account,
      domain: 'bravo.test',
      publicKey: 'p'.repeat(43) + '=',
    });
    const component = fixture.componentInstance;
    component.ngOnInit();
    expect(component.searchText()).toBe(`${account}@bravo.test`);
    expect(userService.resolveFederatedUser).toHaveBeenLastCalledWith(
      { account, domain: 'bravo.test', publicKey: 'p'.repeat(43) + '=' }, expect.any(Function),
    );
    component.cancelSearch();
    expect(component.searchText()).toBe(`${account}@bravo.test`);
    component.searchText.set('someone@other.test');
    component.searchUser();
    expect(userService.resolveFederatedUser).toHaveBeenLastCalledWith(
      { account, domain: 'bravo.test', publicKey: 'p'.repeat(43) + '=' }, expect.any(Function),
    );
  });

  it('keeps only the newest incoming reset when state-feed refreshes overlap', async () => {
    const pending: Array<{
      resolve: (value: FriendIntentPage) => void;
    }> = [];
    const userService = {
      sessionUserId: signal<number | null>(null),
      relationshipRequestStateRevision: signal(0),
      relationshipIntentStateRevision: signal(0),
      friendReqBadge: signal(false),
      listLocalFriendRequests: vi.fn().mockImplementation(
        () =>
          new Promise<FriendIntentPage>((resolve) => {
            pending.push({ resolve });
          }),
      ),
    };
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const component = TestBed.createComponent(
      FriendRequestsComponent,
    ).componentInstance;

    const older = component.loadIncomingInvites(true);
    const newer = component.loadIncomingInvites(true);
    const page = (id: string, name: string) => ({
      items: [
        {
          key: `friend:${id}`,
          namespaceId: 0,
          kind: 'FRIEND' as const,
          bucket: 'RECEIVED' as const,
          direction: 'INCOMING' as const,
          status: 'REQUESTED' as const,
          expiresAt: Date.now() + 60_000,
          localThreadId: null,
          note: '',
          requestedAt: 1,
          requestedSort: 1,
          updatedAt: 1,
          sourceFeedId: Number(id),
          peer: {
            namespaceId: 0,
            id: Number(id),
            account: name,
            avatar: '',
            bio: '',
            domain: 'local',
          },
        },
      ],
      scannedThrough: null,
      hasMore: false,
      total: 1,
      actionableTotal: 1,
    });

    pending[1].resolve(page('2', 'newer'));
    await newer;
    pending[0].resolve(page('1', 'older'));
    await older;

    expect(component.pendingReqList().map((request) => request.id)).toEqual([
      'friend:2',
    ]);
  });

  it.each(['FRIEND', 'GROUP'] as const)(
    'restores the persisted rejected %s request status',
    async (kind) => {
      const identity = {
        namespaceId: 0,
        id: 41,
        account: 'peer',
        domain: 'alpha.test',
        name: 'Peer',
        avatar: '',
        bio: '',
        description: '',
      };
      const userService = {
        sessionUserId: signal<number | null>(null),
        relationshipRequestStateRevision: signal(0),
        relationshipIntentStateRevision: signal(0),
        friendReqBadge: signal(false),
        listLocalFriendRequests: vi
          .fn()
          .mockImplementation((direction: 'INCOMING' | 'OUTGOING') =>
            Promise.resolve({
              items: [
                {
                  key: 'request:41',
                  namespaceId: 0,
                  kind,
                  bucket: direction === 'OUTGOING' ? 'SENT' : 'RECEIVED',
                  direction,
                  status: RequestProjectionStatus.REJECTED,
                  expiresAt: null,
                  localThreadId: null,
                  note: '',
                  requestedAt: 1,
                  requestedSort: 1,
                  updatedAt: 2,
                  peer: identity,
                  group: identity,
                },
              ],
              scannedThrough: null,
              hasMore: false,
              total: 1,
              actionableTotal: 0,
            }),
          ),
      };
      TestBed.configureTestingModule({
        imports: [FriendRequestsComponent],
        providers: [
          provideZonelessChangeDetection(),
          { provide: UserService, useValue: userService },
          { provide: RouteService, useValue: {} },
          { provide: MatSnackBar, useValue: { open: vi.fn() } },
          {
            provide: TranslocoService,
            useValue: { translate: (key: string) => key },
          },
        ],
      }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
      const component = TestBed.createComponent(
        FriendRequestsComponent,
      ).componentInstance;
      await component.loadOutgoingInvites(true);
      await component.loadIncomingInvites(true);
      expect(component.sentReqList()[0].status).toBe(
        RequestProjectionStatus.REJECTED,
      );
      expect(component.pendingReqList()[0].status).toBe(
        RequestProjectionStatus.REJECTED,
      );
    },
  );

  it('opens the shared invite step directly for a local profile shortcut', () => {
    const local: UserRef = {
      id: 7,
      account: 'alice',
      name: 'Alice',
      avatar: '',
      bio: '',
      domain: 'chat.example.test',
      namespaceId: 0,
      isGroup: false,
    };
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: UserService,
          useValue: {
            sessionUserId: signal<number | null>(null),
            relationshipRequestStateRevision: signal(0),
            relationshipIntentStateRevision: signal(0),
            friendReqBadge: signal(false),
          },
        },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const fixture = TestBed.createComponent(FriendRequestsComponent);
    fixture.componentRef.setInput('initialUser', local);

    fixture.detectChanges();

    expect(fixture.componentInstance.inviteUser()).toBe(local);
  });

  it('refreshes only request counts on a live revision without replacing either list', async () => {
    const revision = signal(4);
    const emptyPage = {
      items: [],
      scannedThrough: null,
      hasMore: false,
      total: 0,
    };
    const userService = {
      sessionUserId: signal<number | null>(null),
      relationshipRequestStateRevision: revision,
      relationshipIntentStateRevision: revision,
      friendReqBadge: signal(false),
      listLocalFriendRequests: vi.fn().mockResolvedValue({
        ...emptyPage,
        actionableTotal: 0,
      }),
      markRelationshipRequestsRead: vi.fn(),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const fixture = TestBed.createComponent(FriendRequestsComponent);
    fixture.componentRef.setInput('initialTab', 'pending');
    fixture.detectChanges();
    await fixture.whenStable();

    expect(userService.listLocalFriendRequests).toHaveBeenCalledTimes(2);
    expect(userService.markRelationshipRequestsRead).toHaveBeenCalledTimes(1);
    const component = fixture.componentInstance;
    const incomingReload = vi.spyOn(component, 'loadIncomingInvites');
    const outgoingReload = vi.spyOn(component, 'loadOutgoingInvites');

    revision.set(5);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(userService.listLocalFriendRequests).toHaveBeenCalledTimes(4);
    expect(incomingReload).not.toHaveBeenCalled();
    expect(outgoingReload).not.toHaveBeenCalled();
    expect(userService.listLocalFriendRequests).toHaveBeenNthCalledWith(
      3,
      'INCOMING',
      null,
      1,
    );
    expect(userService.listLocalFriendRequests).toHaveBeenNthCalledWith(
      4,
      'OUTGOING',
      null,
      1,
    );
    expect(userService.markRelationshipRequestsRead).toHaveBeenCalledTimes(1);

    component.setTab(1);
    expect(userService.markRelationshipRequestsRead).toHaveBeenCalledTimes(2);
  });

  it('uses exact resolution for a local account and exposes at most one result', async () => {
    const local: User = {
      id: 7,
      account: 'alice',
      name: 'Alice',
      avatar: '',
      bio: '',
      isGroup: false,
      namespaceId: 0,
      profileRev: 1,
      isDeleted: false,
    };
    const userService = {
      sessionUserId: signal<number | null>(null),
      sessionProfile: () => ({ id: 1 }),
      relationshipIntentStateRevision: signal(0),
      friendReqBadge: signal(false),
      markRelationshipRequestsRead: vi.fn(),
      listLocalFriendRequests: vi.fn().mockResolvedValue({
        items: [],
        scannedThrough: null,
        hasMore: false,
        total: 0,
        actionableTotal: 0,
      }),
      resolveUser: vi.fn().mockReturnValue(of({ code: 0, data: local })),
      searchUsers: vi.fn(),
      localRelationship: vi.fn().mockResolvedValue('NONE'),
    };
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const component = TestBed.createComponent(
      FriendRequestsComponent,
    ).componentInstance;
    component.searchText.set('alice');

    component.searchUser();
    await Promise.resolve();

    expect(userService.resolveUser).toHaveBeenCalledTimes(1);

    expect(userService.resolveUser).toHaveBeenCalledWith({
      account: 'alice',
    });
    expect(userService.searchUsers).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(component.localResults()).toEqual([local]));
  });

  it('shows but does not activate the current user resolved by a bare account', () => {
    const self: User = {
      id: 1,
      account: 'me',
      name: 'Me',
      avatar: '',
      bio: '',
      isGroup: false,
      namespaceId: 0,
      profileRev: 1,
      isDeleted: false,
    };
    const userService = {
      sessionProfile: () => self,
      resolveUser: vi.fn().mockReturnValue(of({ code: 0, data: self })),
      localRelationship: vi.fn(),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const component = TestBed.createComponent(
      FriendRequestsComponent,
    ).componentInstance;
    component.searchText.set('me');

    component.searchUser();
    component.activateResult(self);

    expect(component.localResults()).toEqual([self]);
    expect(component.addTabStatus()).toBe(AddTabStatus.SUCCESS);
    expect(component.inviteUser()).toBeNull();
    expect(userService.localRelationship).not.toHaveBeenCalled();
  });

  it('shows first-contact handshake progress until resolve and localization finish', async () => {
    const resolve = new Subject<{ user: UserRef }>();
    const remote: UserRef = {
      id: 0,
      account: 'bob',
      name: 'Bob',
      avatar: '',
      bio: '',
      domain: 'peer.test',
      namespaceId: 5,
      isGroup: false,
    };
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      relationshipIntentStateRevision: signal(0),
      resolveFederatedUser: vi.fn().mockReturnValue(resolve),
      localRelationship: vi.fn().mockResolvedValue('NONE'),
    };
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const component = TestBed.createComponent(
      FriendRequestsComponent,
    ).componentInstance;
    component.searchText.set('bob@peer.test');

    component.searchUser();

    const progress = vi.mocked(userService.resolveFederatedUser).mock
      .lastCall![1] as (stage: 'WAITING_FOR_PEER') => void;
    progress('WAITING_FOR_PEER');
    expect(component.connectingDomain()).toBe('peer.test');
    expect(component.federationStage()).toBe('WAITING_FOR_PEER');
    expect(component.federationProgress()).toEqual({
      current: 4,
      total: 5,
      percent: 80,
    });
    expect(component.addTabStatus()).toBe(AddTabStatus.SEARCHING);
    resolve.next({ user: remote });
    resolve.complete();
    expect(component.connectingDomain()).toBeNull();
    await vi.waitFor(() => expect(component.localResults()).toEqual([remote]));
    expect(component.addTabStatus()).toBe(AddTabStatus.SUCCESS);
    expect(userService.localRelationship).toHaveBeenCalledWith(remote);
  });

  it('uses the local relationship projection for a resolved own-domain user', async () => {
    const local: UserRef = {
      id: 7,
      account: 'alice',
      name: 'Alice',
      avatar: '',
      bio: '',
      domain: 'local',
      namespaceId: 0,
      isGroup: false,
    };
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      relationshipIntentStateRevision: signal(0),
      resolveFederatedUser: vi.fn().mockReturnValue(of({ user: local })),
      localRelationship: vi.fn().mockResolvedValue('FRIEND'),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const component = TestBed.createComponent(
      FriendRequestsComponent,
    ).componentInstance;
    component.searchText.set('alice@local.test');

    component.searchUser();

    await vi.waitFor(() => expect(component.localResults()).toEqual([local]));
    expect(
      component.relationshipStates().get(component.userIdentity(local)),
    ).toBe('FRIEND');
    expect(component.connectingDomain()).toBeNull();
    expect(component.addTabStatus()).toBe(AddTabStatus.SUCCESS);
  });

  it('allows a new federated request after the synchronized projection records rejection', async () => {
    const remote: UserRef = {
      id: 0,
      account: 'bob',
      name: 'Bob',
      avatar: '',
      bio: '',
      domain: 'peer.test',
      namespaceId: 5,
      isGroup: false,
    };
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      relationshipIntentStateRevision: signal(0),
      resolveFederatedUser: vi.fn().mockReturnValue(of({ user: remote })),
      localRelationship: vi.fn().mockResolvedValue('NONE'),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const component = TestBed.createComponent(
      FriendRequestsComponent,
    ).componentInstance;
    component.searchText.set('bob@peer.test');

    component.searchUser();

    await vi.waitFor(() => expect(component.localResults()).toEqual([remote]));
    expect(component.relationshipLabel(remote)).toBe('friend.addAction');
    component.activateResult(remote);
    expect(component.inviteUser()).toEqual(remote);
  });

  it('shows but does not activate the current user resolved through an explicit own-domain address', () => {
    const self: UserRef = {
      id: 1,
      account: 'me',
      name: 'Me',
      avatar: '',
      bio: '',
      namespaceId: 0,
      isGroup: false,
    };
    const userService = {
      sessionProfile: () => self,
      resolveFederatedUser: vi.fn().mockReturnValue(of({ user: self })),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const component = TestBed.createComponent(
      FriendRequestsComponent,
    ).componentInstance;
    component.searchText.set('me@local.test');

    component.searchUser();

    expect(component.localResults()).toEqual([self]);
    expect(component.addTabStatus()).toBe(AddTabStatus.SUCCESS);

    component.activateResult(self);

    expect(component.inviteUser()).toBeNull();
  });

  it('cancels an in-flight resolve and clears the handshake affordance', () => {
    const resolve = new Subject<{ user: User }>();
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      resolveFederatedUser: () => resolve,
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const component = TestBed.createComponent(
      FriendRequestsComponent,
    ).componentInstance;
    component.searchText.set('bob@peer.test');
    component.searchUser();

    component.cancelSearch();

    expect(component.connectingDomain()).toBeNull();
    expect(component.addTabStatus()).toBe(AddTabStatus.INIT);
    expect(resolve.observed).toBe(false);
  });

  it('reports a missing federated account as user not found', () => {
    const resolve = new Subject<never>();
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      resolveFederatedUser: () => resolve,
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const component = TestBed.createComponent(
      FriendRequestsComponent,
    ).componentInstance;
    component.searchText.set('missing@peer.test');

    component.searchUser();
    resolve.error(new FederatedResolveError('NOT_FOUND'));

    expect(component.addTabStatus()).toBe(AddTabStatus.ERROR);
    expect(component.errMsg()).toBe('friend.msg.friendNotFound');
  });

  it('retains an in-flight action across a list reset and applies its optimistic result by id', async () => {
    const acceptResult = new Subject<{ code: number }>();
    let resolveRefresh!: (value: FriendIntentPage) => void;
    const userService = {
      relationshipRequestStateRevision: signal(0),
      relationshipIntentStateRevision: signal(0),
      friendReqBadge: signal(false),
      acceptRelationship: vi.fn().mockReturnValue(acceptResult),
      markRelationshipRequestAccepted: vi.fn().mockResolvedValue(undefined),
      listLocalFriendRequests: vi.fn().mockImplementation(
        () =>
          new Promise<FriendIntentPage>((resolve) => {
            resolveRefresh = resolve;
          }),
      ),
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(FriendRequestsComponent, { set: { template: '' } });
    const component = TestBed.createComponent(
      FriendRequestsComponent,
    ).componentInstance;
    const request = {
      id: 'friend:41',
      projectionKey: 'friend:41',
      account: 'alice',
      namespaceId: 0,
      direction: 'INCOMING' as const,
      status: RequestProjectionStatus.REQUESTED,
      date: 1,
      errText: '',
    };
    component.pendingReqList.set([request]);

    component.approve(request);
    component.approve(request);

    expect(userService.acceptRelationship).toHaveBeenCalledTimes(1);
    expect(component.isInviteActionPending(request.id)).toBe(true);

    const refresh = component.loadIncomingInvites(true);

    // Reset refreshes keep the currently rendered row and its disabled action state until the new
    // snapshot is ready; they do not unsubscribe the mutation request.
    expect(component.pendingReqList()).toEqual([request]);
    expect(acceptResult.observed).toBe(true);
    expect(component.isInviteActionPending(request.id)).toBe(true);

    resolveRefresh({
      items: [
        {
          key: request.projectionKey,
          namespaceId: 0,
          kind: 'FRIEND',
          bucket: 'RECEIVED',
          direction: 'INCOMING',
          note: '',
          status: 'REQUESTED',
          expiresAt: Date.now() + 60_000,
          localThreadId: null,
          requestedAt: 2,
          requestedSort: 2,
          updatedAt: 2,
          sourceFeedId: 2,
          peer: {
            namespaceId: 0,
            id: 41,
            account: 'alice',
            avatar: '',
            bio: '',
            domain: 'local',
          },
        },
      ],
      scannedThrough: null,
      hasMore: false,
      total: 1,
      actionableTotal: 1,
    });
    await refresh;

    expect(component.pendingReqList()[0].account).toBe('alice');
    expect(component.pendingReqList()[0]).not.toHaveProperty('name');
    expect(component.isInviteActionPending(request.id)).toBe(true);

    acceptResult.next({ code: 0 });
    acceptResult.complete();
    await Promise.resolve();

    expect(component.pendingReqList()[0]).toEqual(
      expect.objectContaining({
        id: request.id,
        status: RequestProjectionStatus.ACCEPTED,
      }),
    );
    expect(userService.markRelationshipRequestAccepted).toHaveBeenCalledWith(
      request.projectionKey,
    );
    expect(acceptResult.observed).toBe(false);
    expect(component.isInviteActionPending(request.id)).toBe(false);
  });
});
