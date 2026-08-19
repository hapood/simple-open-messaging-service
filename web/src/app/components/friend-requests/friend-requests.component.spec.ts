import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { RouteService } from '../../services/route.service';
import type { User } from '../../services/model';
import { UserService } from '../../services/user.service';
import {
  AddTabStatus,
  FriendRequestsComponent,
} from './friend-requests.component';

describe('FriendRequestsComponent federated search progress', () => {
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
        { provide: UserService, useValue: {} },
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
});
