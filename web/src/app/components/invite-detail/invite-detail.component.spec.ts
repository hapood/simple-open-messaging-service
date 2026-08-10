import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MatSnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';
import { of } from 'rxjs';
import { NavStateMachineService } from '../../services/nav-state.service';
import type { InviteDetail } from '../../services/model';
import { UserService } from '../../services/user.service';
import { InviteDetailComponent } from './invite-detail.component';

const detail = (over: Partial<InviteDetail> = {}): InviteDetail =>
  ({
    id: '1',
    kind: 'GROUP',
    status: 'PENDING',
    expiresAt: Date.now() + 60_000,
    note: '',
    threadId: 12,
    groupName: 'Federated group',
    groupAvatar: '',
    groupDomain: 'origin.test',
    groupIsLocal: false,
    alreadyJoined: false,
    joinRequested: false,
    fromUser: { id: 1, account: 'alice', name: 'Alice' },
    ...over,
  }) as InviteDetail;

describe('InviteDetailComponent federation confirmation', () => {
  let component: InviteDetailComponent;
  let joinGroupRequest: jasmine.Spy;
  let getInviteDetail: jasmine.Spy;
  let openChat: jasmine.Spy;
  let snack: jasmine.Spy;

  beforeEach(() => {
    joinGroupRequest = jasmine.createSpy().and.returnValue(of({ code: 0 }));
    getInviteDetail = jasmine
      .createSpy()
      .and.returnValue(of({ code: 0, data: detail({ joinRequested: true }) }));
    openChat = jasmine.createSpy();
    snack = jasmine.createSpy();
    TestBed.configureTestingModule({
      imports: [InviteDetailComponent],
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: UserService,
          useValue: { joinGroupRequest, getInviteDetail },
        },
        { provide: NavStateMachineService, useValue: { openChat } },
        { provide: MatSnackBar, useValue: { open: snack } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    }).overrideComponent(InviteDetailComponent, { set: { template: '' } });
    component = TestBed.createComponent(
      InviteDetailComponent,
    ).componentInstance;
  });

  it('keeps a federated join on the card until the origin confirms it', async () => {
    component.detail.set(detail());
    component.inviteId.set('!group');

    await component.onJoin();

    expect(joinGroupRequest).toHaveBeenCalledWith({ groupId: 12 });
    expect(openChat).not.toHaveBeenCalled();
    expect(snack).toHaveBeenCalledWith(
      'chat.federatedJoinRequested',
      undefined,
      { duration: 3500 },
    );
    expect(component.viewState()).toBe('requested');
  });

  it('still enters a local group because this server confirms synchronously', async () => {
    component.detail.set(detail({ groupIsLocal: true, groupDomain: '' }));

    await component.onJoin();

    expect(openChat).toHaveBeenCalledWith(12, 'group-joined');
    expect(snack).not.toHaveBeenCalled();
  });

  it('opens the group after a later origin confirmation is visible on the card', async () => {
    component.detail.set(
      detail({ alreadyJoined: true, joinRequested: false, status: 'ACCEPTED' }),
    );

    expect(component.viewState()).toBe('joined');
    await component.onOpen();

    expect(openChat).toHaveBeenCalledWith(12);
  });

  it('shows the origin rejection reason and does not enter when the group is full', async () => {
    const reason = "Group has reached this server's 999-member limit.";
    joinGroupRequest.and.returnValue(of({ code: 40008, message: reason }));
    getInviteDetail.and.returnValue(
      of({
        code: 0,
        data: detail({ status: 'REVOKED', joinRequested: false }),
      }),
    );
    component.detail.set(detail());
    component.inviteId.set('!group');

    await component.onJoin();
    await Promise.resolve();

    expect(openChat).not.toHaveBeenCalled();
    expect(component.errorMsg()).toBe(reason);
    expect(component.viewState()).toBe('invalid');
    expect(component.busy()).toBeFalse();
  });
});
