import { RequestProjectionStatus } from '../../../../../shared/request-projection-status';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { RouteService } from '../../services/route.service';
import type { UserRef } from '../../services/model';
import type {
  PersonalRequestPage,
} from '../../../../../shared/relationship-request';
import type { StandardResponse } from '../../services/model';
import {
  FederatedResolveError,
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

  it('keeps only the newest incoming reset when overlapping online loads finish out of order', async () => {
    const pending: Array<{
      resolve: (value: PersonalRequestPage) => void;
    }> = [];
    const userService = {
      sessionUserId: signal<number | null>(null),
      friendReqBadge: signal(false),
      queryRelationshipRequests: vi.fn().mockImplementation(() => {
        const subject = new Subject<StandardResponse<PersonalRequestPage>>();
        pending.push({
          resolve: (page) => subject.next({ code: 0, message: 'ok', data: page }),
        });
        return subject.asObservable();
      }),
      observeIncomingRequestPage: vi.fn().mockResolvedValue(undefined),
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
    const page = (id: string, name: string): PersonalRequestPage => ({
      items: [
        {
          id: `friend:${id}`,
          kind: 'FRIEND',
          author: { account: name, namespaceId: 0 },
          receiver: { account: 'me', namespaceId: 0 },
          direction: 'INCOMING' as const,
          authorProfile: { account: name, namespaceId: 0, profileNamespaceId: 0, profileRev: 1 },
          status: 'REQUESTED' as const,
          note: '',
          requestedAt: '2026-01-01T00:00:00Z',
          expiresAt: '2026-01-08T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
          updatedAt: '2026-01-01T00:00:00Z',
        },
      ],
      hasMore: false,
      before: null,
      incomingHead: { requestEndId: id, requestReadId: '0' },
    });

    pending[1].resolve(page('2', 'newer'));
    await newer;
    pending[0].resolve(page('1', 'older'));
    await older;

    expect(component.pendingReqList().map((request) => request.id)).toEqual([
      'friend:2',
    ]);
    expect(userService.observeIncomingRequestPage).toHaveBeenCalledWith({
      requestEndId: '2',
      requestReadId: '0',
    });
  });

  it.each(['FRIEND', 'GROUP_APPLICATION'] as const)(
    'renders the server round for a rejected %s request',
    async (kind) => {
      const userService = {
        sessionUserId: signal<number | null>(null),
        friendReqBadge: signal(false),
        queryRelationshipRequests: vi.fn().mockImplementation(
          (params: { bucket: 'RECEIVED' | 'SENT' }) =>
            of({
              code: 0,
              message: 'ok',
              data: {
                items: [
                  params.bucket === 'SENT'
                    ? {
                        id: 'request:41',
                        kind,
                        author: { account: 'me', namespaceId: 0 },
                        receiver: { account: 'peer', namespaceId: 0 },
                        direction: 'OUTGOING' as const,
                        snapshot: { displayName: 'Sent Peer', avatar: null },
                        status: 'REJECTED' as const,
                        note: 'Please let me join',
                        requestedAt: '2026-01-01T00:00:00Z',
                        expiresAt: '2026-01-08T00:00:00Z',
                        createdAt: '2026-01-01T00:00:00Z',
                        updatedAt: '2026-01-02T00:00:00Z',
                      }
                    : {
                        id: 'request:41',
                        kind,
                        author: { account: 'peer', namespaceId: 0 },
                        receiver: { account: 'me', namespaceId: 0 },
                        direction: 'INCOMING' as const,
                        authorProfile: {
                          account: 'peer',
                          namespaceId: 0,
                          profileNamespaceId: 0,
                          profileRev: 3,
                        },
                        status: 'REJECTED' as const,
                        note: 'Please let me join',
                        requestedAt: '2026-01-01T00:00:00Z',
                        expiresAt: '2026-01-08T00:00:00Z',
                        createdAt: '2026-01-01T00:00:00Z',
                        updatedAt: '2026-01-02T00:00:00Z',
                      },
                ],
                hasMore: false,
                before: null,
                ...(params.bucket === 'RECEIVED'
                  ? { incomingHead: { requestEndId: '1', requestReadId: '1' } }
                  : {}),
              },
            }),
        ),
        observeIncomingRequestPage: vi.fn().mockResolvedValue(undefined),
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
      expect(component.sentReqList()[0].snapshot).toEqual({ displayName: 'Sent Peer', avatar: null });
      expect(component.avatarProfile(component.sentReqList()[0])).toBeUndefined();
      expect(component.sentReqList()[0].reqMessage).toBe('Please let me join');
      expect(component.pendingReqList()[0].reqMessage).toBe('Please let me join');
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

  it('loads both online buckets once on open without extra refreshes', async () => {
    const userService = {
      sessionUserId: signal<number | null>(null),
      friendReqBadge: signal(false),
      queryRelationshipRequests: vi.fn().mockImplementation(
        (params: { bucket: 'RECEIVED' | 'SENT' }) =>
          of({
            code: 0,
            message: 'ok',
            data: {
              items: [],
              hasMore: false,
              before: null,
              ...(params.bucket === 'RECEIVED'
                ? { incomingHead: { requestEndId: '0', requestReadId: '0' } }
                : {}),
            },
          }),
      ),
      observeIncomingRequestPage: vi.fn().mockResolvedValue(undefined),
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

    expect(userService.queryRelationshipRequests).toHaveBeenCalledTimes(2);
    expect(userService.queryRelationshipRequests).toHaveBeenNthCalledWith(1, {
      bucket: 'RECEIVED',
      take: 20,
    });
    expect(userService.queryRelationshipRequests).toHaveBeenNthCalledWith(2, {
      bucket: 'SENT',
      take: 20,
    });
    // Viewing the received page marks it read exactly once per load.
    expect(userService.observeIncomingRequestPage).toHaveBeenCalledTimes(1);

    const component = fixture.componentInstance;
    component.setTab(1);
    fixture.detectChanges();
    await fixture.whenStable();
    expect(userService.queryRelationshipRequests).toHaveBeenCalledTimes(2);
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

  it.each(['STALE_REQUEST', 'EXPIRED'] as const)(
    'does not display a failed request decision (%s) as accepted, rejected or withdrawn',
    (status) => {
      const result = of({ code: 0, message: '', data: { status } });
      const userService = {
        friendReqBadge: signal(false),
        acceptRelationship: vi.fn().mockReturnValue(result),
        rejectRelationshipRequest: vi.fn().mockReturnValue(result),
        withdrawRelationshipRequest: vi.fn().mockReturnValue(result),
      };
      TestBed.resetTestingModule();
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
      const component = TestBed.createComponent(FriendRequestsComponent).componentInstance;
      vi.spyOn(component, 'loadIncomingInvites').mockResolvedValue(undefined);
      const incoming = {
        id: '41', requestId: '41', snapshot: null, account: 'alice',
        namespaceId: 0, direction: 'INCOMING' as const,
        status: RequestProjectionStatus.REQUESTED, date: 1, errText: '',
      };
      const outgoing = { ...incoming, id: '42', requestId: '42', direction: 'OUTGOING' as const };
      component.pendingReqList.set([incoming]);
      component.sentReqList.set([outgoing]);
      component.approve(incoming);
      component.rejectIncoming(incoming);
      component.cancelSent(outgoing);
      expect(component.pendingReqList()[0].status).toBe(RequestProjectionStatus.REQUESTED);
      expect(component.sentReqList()[0].status).toBe(RequestProjectionStatus.REQUESTED);
      expect(userService.acceptRelationship).toHaveBeenCalledWith({ requestId: '41' });
      expect(userService.rejectRelationshipRequest).toHaveBeenCalledWith({ requestId: '41' });
      expect(userService.withdrawRelationshipRequest).toHaveBeenCalledWith({ requestId: '42' });
    },
  );

  it('retains an in-flight action across a list reset and applies its result by id', async () => {
    const acceptResult = new Subject<{ code: number; data: { status: 'OK' } }>();
    let resolveRefresh!: (value: PersonalRequestPage) => void;
    const refreshSubject = () => {
      const subject = new Subject<StandardResponse<PersonalRequestPage>>();
      resolveRefresh = (page) =>
        subject.next({ code: 0, message: 'ok', data: page });
      return subject.asObservable();
    };
    const userService = {
      friendReqBadge: signal(false),
      acceptRelationship: vi.fn().mockReturnValue(acceptResult),
      queryRelationshipRequests: vi
        .fn()
        .mockImplementation(refreshSubject),
      observeIncomingRequestPage: vi.fn().mockResolvedValue(undefined),
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
      requestId: 'friend:41',
      snapshot: null,
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
    expect(userService.acceptRelationship).toHaveBeenCalledWith({
      requestId: 'friend:41',
    });
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
          id: request.requestId,
          kind: 'FRIEND',
          author: { account: 'alice', namespaceId: 0 },
          receiver: { account: 'me', namespaceId: 0 },
          direction: 'INCOMING' as const,
          authorProfile: {
            account: 'alice',
            namespaceId: 0,
            profileNamespaceId: 0,
            profileRev: 1,
          },
          status: 'REQUESTED' as const,
          note: '',
          requestedAt: '2026-01-02T00:00:00Z',
          expiresAt: '2026-01-09T00:00:00Z',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
        },
      ],
      hasMore: false,
      before: null,
      incomingHead: { requestEndId: '2', requestReadId: '1' },
    });
    await refresh;

    expect(component.pendingReqList()[0].account).toBe('alice');
    expect(component.pendingReqList()[0]).not.toHaveProperty('name');
    expect(component.isInviteActionPending(request.id)).toBe(true);

    acceptResult.next({ code: 0, data: { status: 'OK' } });
    acceptResult.complete();
    await Promise.resolve();

    expect(component.pendingReqList()[0]).toEqual(
      expect.objectContaining({
        id: request.id,
        status: RequestProjectionStatus.ACCEPTED,
      }),
    );
    expect(acceptResult.observed).toBe(false);
    expect(component.isInviteActionPending(request.id)).toBe(false);
  });
});
