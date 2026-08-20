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
      listLocalFriendInvites: vi.fn().mockImplementation(
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
          id,
          kind: 'FRIEND' as const,
          note: '',
          status: 'PENDING' as const,
          createdAt: 1,
          expiresAt: Date.now() + 60_000,
          fromUser: {
            id: Number(id),
            account: name,
            name,
            avatar: '',
            domain: '',
            isForeigner: false,
          },
          toUser: {
            id: 99,
            account: 'me',
            name: 'Me',
            avatar: '',
            domain: '',
            isForeigner: false,
          },
        },
      ],
      nextCursor: null,
      hasMore: false,
      total: 1,
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
      isForeigner: false,
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

  it('refreshes both request tabs on a live revision without marking it read', async () => {
    const revision = signal(4);
    const emptyPage = {
      items: [],
      nextCursor: null,
      hasMore: false,
      total: 0,
    };
    const userService = {
      friendRequestStateRevision: revision,
      friendIntentStateRevision: revision,
      friendReqBadge: signal(false),
      listLocalFriendInvites: vi.fn().mockResolvedValue(emptyPage),
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

    expect(userService.listLocalFriendInvites).toHaveBeenCalledTimes(2);
    expect(userService.markFriendReqRead).toHaveBeenCalledTimes(1);

    revision.set(5);
    fixture.detectChanges();
    await fixture.whenStable();

    expect(userService.listLocalFriendInvites).toHaveBeenCalledTimes(4);
    expect(userService.markFriendReqRead).toHaveBeenCalledTimes(1);

    fixture.componentInstance.setTab(1);
    expect(userService.markFriendReqRead).toHaveBeenCalledTimes(2);
  });

  it('uses exact resolution for a local account and exposes at most one result', () => {
    const local = {
      id: 7,
      account: 'alice',
      name: 'Alice',
      isForeigner: false,
    } as User;
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      resolveUser: vi.fn().mockReturnValue(of({ code: 0, data: local })),
      searchUsers: vi.fn(),
      friendRelationshipStatuses: vi
        .fn()
        .mockReturnValue(
          of({ code: 0, data: [{ userId: local.id, status: 'NONE' }] }),
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
    component.searchText.set('alice');

    component.searchUser();

    expect(userService.resolveUser).toHaveBeenCalledTimes(1);

    expect(userService.resolveUser).toHaveBeenCalledWith({
      account: 'alice',
    });
    expect(userService.searchUsers).not.toHaveBeenCalled();
    expect(component.localResults()).toEqual([local]);
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
      isForeigner: true,
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

  it('serializes actions per invite and cancels them when the list resets', async () => {
    const acceptResult = new Subject<{ code: number }>();
    const userService = {
      friendRequestStateRevision: signal(0),
      friendIntentStateRevision: signal(0),
      friendReqBadge: signal(false),
      acceptInvite: vi.fn().mockReturnValue(acceptResult),
      rejectInvite: vi.fn().mockReturnValue(new Subject<{ code: number }>()),
      listLocalFriendInvites: vi.fn().mockResolvedValue({
        items: [],
        nextCursor: null,
        hasMore: false,
        total: 0,
      }),
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
      status: 0,
      date: 1,
      errText: '',
    };
    component.pendingReqList.set([request]);

    component.approve(request);
    component.approve(request);
    component.decline(request);

    expect(userService.acceptInvite).toHaveBeenCalledTimes(1);
    expect(userService.rejectInvite).not.toHaveBeenCalled();
    expect(component.isInviteActionPending(request.id)).toBe(true);

    await component.loadIncomingInvites(true);

    expect(acceptResult.observed).toBe(false);
    expect(component.isInviteActionPending(request.id)).toBe(false);
  });
});
