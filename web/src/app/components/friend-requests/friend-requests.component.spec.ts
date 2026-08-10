import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';
import { of, Subject } from 'rxjs';
import { RouteService } from '../../services/route.service';
import type { StandardResponse, User } from '../../services/model';
import { UserService } from '../../services/user.service';
import {
  AddTabStatus,
  FriendRequestsComponent,
} from './friend-requests.component';

describe('FriendRequestsComponent federated search progress', () => {
  it('shows first-contact handshake progress until resolve and localization finish', () => {
    const resolve = new Subject<StandardResponse<User>>();
    const remote = {
      id: 9,
      account: 'bob',
      name: 'Bob',
      domain: 'peer.test',
      isForeigner: true,
    } as User;
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      peerTrustStatus: jasmine
        .createSpy()
        .and.returnValue(of({ code: 0, data: { trusted: false } })),
      resolveUser: jasmine.createSpy().and.returnValue(resolve),
      friendRelationshipStatuses: jasmine
        .createSpy()
        .and.returnValue(
          of({ code: 0, data: [{ userId: remote.id, status: 'NONE' }] }),
        ),
    };
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: jasmine.createSpy() } },
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
    expect(component.addTabStatus()).toBe(AddTabStatus.SEARCHING);
    resolve.next({ code: 0, message: '', data: remote });
    resolve.complete();
    expect(component.connectingDomain()).toBeNull();
    expect(component.addTabStatus()).toBe(AddTabStatus.SUCCESS);
    expect(component.localResults()).toEqual([remote]);
  });

  it('cancels an in-flight resolve and clears the handshake affordance', () => {
    const resolve = new Subject<StandardResponse<User>>();
    const userService = {
      sessionProfile: () => ({ id: 1 }),
      peerTrustStatus: () => of({ code: 0, data: { trusted: false } }),
      resolveUser: () => resolve,
    };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FriendRequestsComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: UserService, useValue: userService },
        { provide: RouteService, useValue: {} },
        { provide: MatSnackBar, useValue: { open: jasmine.createSpy() } },
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
    expect(resolve.observed).toBeFalse();
  });
});
