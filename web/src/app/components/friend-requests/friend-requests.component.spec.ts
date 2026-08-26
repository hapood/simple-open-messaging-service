import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { RouteService } from '../../services/route.service';
import type { User } from '../../services/model';
import {
  FederatedResolveError,
  FriendIntentPage,
  UserService,
} from '../../services/user.service';
import {
  AddTabStatus,
  FriendRequestsComponent,
} from './friend-requests.component';

describe('FriendRequestsComponent federated search progress', () => {
  it('keeps only the newest incoming reset when state-feed refreshes overlap', async () => {
    const pending: Array<{
      resolve: (value: FriendIntentPage) => void;
    }> = [];
    const userService = {
      friendRequestStateRevision: signal(0),
      friendIntentStateRevision: signal(0),
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
          kind: 'FRIEND' as const,
          bucket: 'RECEIVED' as const,
          direction: 'INCOMING' as const,
          status: 'REQUESTED' as const,
          expiresAt: Date.now() + 60_000,
          localThreadId: null,
          inviteId: id,
          note: '',
          requestedAt: 1,
          requestedSort: 1,
          updatedAt: 1,
          peer: {
            id: Number(id),
            account: name,
            name,
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
      '2',
    ]);
  });

  it('opens the shared invite step directly for a local profile shortcut', () => {
    const local = {
      id: 7,
      account: 'alice',
      name: 'Alice',
    } as User;
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: UserService,
          useValue: {
            friendRequestStateRevision: signal(0),
            friendIntentStateRevision: signal(0),
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
      friendRequestStateRevision: revision,
      friendIntentStateRevision: revision,
      friendReqBadge: signal(false),
      listLocalFriendRequests: vi.fn().mockResolvedValue({
        ...emptyPage,
        actionableTotal: 0,
      }),
      markFriendReqRead: vi.fn(),
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
    expect(userService.markFriendReqRead).toHaveBeenCalledTimes(1);
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
    expect(userService.markFriendReqRead).toHaveBeenCalledTimes(1);

    component.setTab(1);
    expect(userService.markFriendReqRead).toHaveBeenCalledTimes(2);
  });

  it('uses exact resolution for a local account and exposes at most one result', async () => {
    const local = {
      id: 7,
      account: 'alice',
      name: 'Alice',
    } as User;
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      friendIntentStateRevision: signal(0),
      friendReqBadge: signal(false),
      markFriendReqRead: vi.fn(),
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
    const self = {
      id: 1,
      account: 'me',
      name: 'Me',
    } as User;
    const userService = {
      sessionProfile: () => ({ id: self.id }),
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

  it('shows first-contact handshake progress until resolve and localization finish', () => {
    const resolve = new Subject<{
      user: User;
      relationship: 'NONE';
    }>();
    const remote = {
      id: 0,
      account: 'bob',
      name: 'Bob',
      domain: 'peer.test',
    } as User;
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      peerTrustStatus: vi
        .fn()
        .mockReturnValue(of({ code: 0, data: { trusted: false } })),
      resolveFederatedUser: vi.fn().mockReturnValue(resolve),
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

    expect(component.connectingDomain()).toBe('peer.test');
    const progress = vi.mocked(userService.resolveFederatedUser).mock
      .lastCall![1] as (stage: 'WAITING_FOR_PEER') => void;
    progress('WAITING_FOR_PEER');
    expect(component.federationStage()).toBe('WAITING_FOR_PEER');
    expect(component.federationProgress()).toEqual({
      current: 4,
      total: 5,
      percent: 80,
    });
    expect(component.addTabStatus()).toBe(AddTabStatus.SEARCHING);
    resolve.next({ user: remote, relationship: 'NONE' });
    resolve.complete();
    expect(component.connectingDomain()).toBeNull();
    expect(component.addTabStatus()).toBe(AddTabStatus.SUCCESS);
    expect(component.localResults()).toEqual([remote]);
  });

  it('keeps the relationship state keyed to a locally resolved own-domain user', () => {
    const local = {
      id: 7,
      account: 'alice',
      name: 'Alice',
      domain: 'local',
    } as User;
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      peerTrustStatus: vi
        .fn()
        .mockReturnValue(of({ code: 0, data: { trusted: true } })),
      resolveFederatedUser: vi
        .fn()
        .mockReturnValue(of({ user: local, relationship: 'FRIEND' })),
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

    expect(component.localResults()).toEqual([local]);
    expect(component.relationshipStates().get(local.id)).toBe('FRIEND');
    expect(component.connectingDomain()).toBeNull();
    expect(component.addTabStatus()).toBe(AddTabStatus.SUCCESS);
  });

  it('shows but does not activate the current user resolved through an explicit own-domain address', () => {
    const self = {
      id: 1,
      account: 'me',
      name: 'Me',
      domain: 'local',
    } as User;
    const userService = {
      sessionProfile: () => ({ id: self.id }),
      peerTrustStatus: vi
        .fn()
        .mockReturnValue(of({ code: 0, data: { trusted: true } })),
      resolveFederatedUser: vi
        .fn()
        .mockReturnValue(of({ user: self, relationship: 'NONE' })),
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
    const resolve = new Subject<{
      user: User;
      relationship: 'NONE';
    }>();
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      peerTrustStatus: () => of({ code: 0, data: { trusted: false } }),
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
      peerTrustStatus: () => of({ code: 0, data: { trusted: true } }),
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
      friendRequestStateRevision: signal(0),
      friendIntentStateRevision: signal(0),
      friendReqBadge: signal(false),
      acceptInvite: vi.fn().mockReturnValue(acceptResult),
      markFriendRequestAccepted: vi.fn().mockResolvedValue(undefined),
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
      id: '41',
      projectionKey: 'friend:41',
      direction: 'INCOMING' as const,
      status: 0,
      date: 1,
      errText: '',
    };
    component.pendingReqList.set([request]);

    component.approve(request);
    component.approve(request);

    expect(userService.acceptInvite).toHaveBeenCalledTimes(1);
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
          kind: 'FRIEND',
          bucket: 'RECEIVED',
          direction: 'INCOMING',
          note: '',
          status: 'REQUESTED',
          expiresAt: Date.now() + 60_000,
          localThreadId: null,
          inviteId: request.id,
          requestedAt: 2,
          requestedSort: 2,
          updatedAt: 2,
          peer: {
            id: 41,
            account: 'alice',
            name: 'Alice refreshed',
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

    expect(component.pendingReqList()[0].name).toBe('Alice refreshed');
    expect(component.isInviteActionPending(request.id)).toBe(true);

    acceptResult.next({ code: 0 });
    acceptResult.complete();
    await Promise.resolve();

    expect(component.pendingReqList()[0]).toEqual(
      expect.objectContaining({ id: request.id, status: 1 }),
    );
    expect(userService.markFriendRequestAccepted).toHaveBeenCalledWith(
      request.projectionKey,
    );
    expect(acceptResult.observed).toBe(false);
    expect(component.isInviteActionPending(request.id)).toBe(false);
  });
});
