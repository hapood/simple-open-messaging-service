import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TranslocoService } from '@jsverse/transloco';
import { GroupJoinRequestsComponent } from './group-join-requests.component';
import {
  GroupService,
  type GroupJoinRequest,
} from '../../services/group.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { ToastService } from '../../services/toast.service';
import { UserService } from '../../services/user.service';

function row(feedId: number, status: GroupJoinRequest['status'] = 'REQUESTED') {
  return {
    feedId,
    status,
    namespaceId: 0,
    profileRev: 1,
    account: `user-${feedId}`,
    domain: 'local',
    name: `User ${feedId}`,
    avatar: '',
    note: '',
    requestedAt: null,
    expiresAt: null,
  } satisfies GroupJoinRequest;
}

function response(item?: GroupJoinRequest) {
  return {
    code: 0,
    data: {
      data: item ? [item] : [],
      hasMore: false,
      before: item?.feedId ?? null,
    },
  };
}

describe('GroupJoinRequestsComponent', () => {
  function create(
    queryJoinRequests: ReturnType<typeof vi.fn>,
    unreadApplications = false,
  ) {
    const thread = {
      threadId: 7,
      joinRequestEndFeedId: 2,
      joinRequestReadFeedId: unreadApplications ? 0 : 2,
    };
    const markJoinRequestsReadLocally = vi.fn();
    const groups = {
      queryJoinRequests,
      queryInvitations: vi.fn(() => of(response())),
      queryInviteCandidates: vi.fn(() =>
        of({
          code: 0,
          data: { data: [], hasMore: false, afterThreadId: null },
        }),
      ),
      markJoinRequestsRead: vi.fn(() => of({ code: 0 })),
      acceptJoinRequest: vi.fn(() => of({ code: 0 })),
      rejectJoinRequest: vi.fn(() => of({ code: 0 })),
      revokeInvitation: vi.fn(() => of({ code: 0 })),
      inviteUsers: vi.fn(() =>
        of({ code: 0, data: { invited: [], skipped: [] } }),
      ),
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: GroupService, useValue: groups },
        {
          provide: ConversationListService,
          useValue: {
            openThreadId: () => 7,
            items: () => [thread],
            markJoinRequestsReadLocally,
          },
        },
        { provide: UserService, useValue: {} },
        { provide: NavStateMachineService, useValue: { back: vi.fn() } },
        { provide: ToastService, useValue: { warn: vi.fn() } },
        {
          provide: TranslocoService,
          useValue: { translate: (key: string) => key },
        },
      ],
    });
    return {
      component: TestBed.runInInjectionContext(
        () => new GroupJoinRequestsComponent(),
      ),
      groups,
      markJoinRequestsReadLocally,
    };
  }

  it('loads applications when the application tab opens', async () => {
    const queryJoinRequests = vi.fn(() => of(response(row(2))));
    const { component, groups, markJoinRequestsReadLocally } = create(
      queryJoinRequests,
      true,
    );
    component.setTab(1);
    await Promise.resolve();
    expect(queryJoinRequests).toHaveBeenCalledWith({
      groupId: 7,
      before: undefined,
      take: 20,
    });
    expect(component.applications()).toEqual([row(2)]);
    expect(markJoinRequestsReadLocally).toHaveBeenCalledWith(7, 2);
    expect(groups.markJoinRequestsRead).toHaveBeenCalledWith({
      groupId: 7,
      joinRequestReadFeedId: 2,
    });
  });

  it('does not mark applications read when the list request fails', async () => {
    const queryJoinRequests = vi.fn(() =>
      of({ code: 1, message: 'failed', data: undefined }),
    );
    const { groups, markJoinRequestsReadLocally } = create(
      queryJoinRequests,
      true,
    );
    await Promise.resolve();
    expect(markJoinRequestsReadLocally).not.toHaveBeenCalled();
    expect(groups.markJoinRequestsRead).not.toHaveBeenCalled();
  });

  it('invites a foreign friend by its address', async () => {
    const { component, groups } = create(vi.fn(() => of(response())));
    const candidate = {
      threadId: 12,
      namespaceId: 7,
      profileRev: 1,
      account: 'friend',
      domain: 'peer.test',
      name: 'Friend',
      avatar: '',
      bio: '',
      state: 'AVAILABLE' as const,
    };
    component.candidates.set([candidate]);
    groups.inviteUsers.mockReturnValue(
      of({
        code: 0,
        data: {
          invited: [{ account: 'friend', domain: 'peer.test' }],
          skipped: [],
        },
      }) as never,
    );
    await component.invite(candidate);
    expect(groups.inviteUsers).toHaveBeenCalledWith({
      groupId: 7,
      users: [{ account: 'friend', domain: 'peer.test' }],
    });
    expect(component.candidates()[0].state).toBe('INVITED');
  });

  it('re-enables a foreign candidate by address after revoking its invitation', async () => {
    const { component, groups } = create(vi.fn(() => of(response())));
    component.candidates.set([
      {
        threadId: 12,
        namespaceId: 7,
        profileRev: 1,
        account: 'friend',
        domain: 'peer.test',
        name: 'Friend',
        avatar: '',
        bio: '',
        state: 'INVITED',
      },
    ]);
    component.invitations.set([
      { ...row(12), account: 'friend', domain: 'peer.test' },
    ]);
    await component.revokeInvitation(component.invitations()[0]);
    expect(groups.revokeInvitation).toHaveBeenCalledWith({
      groupId: 7,
      account: 'friend',
      domain: 'peer.test',
    });
    expect(component.candidates()[0].state).toBe('AVAILABLE');
  });

  it('does not attribute a withdrawn or expired application to a manager rejection', async () => {
    const withdrawn = row(2, 'WITHDRAWN');
    const { component, groups } = create(
      vi.fn(() => of(response(withdrawn))),
      true,
    );
    await Promise.resolve();
    expect(
      component.applicationStatusKey(component.applications()[0].status),
    ).toBe('friend.revoked');
    expect(groups.rejectJoinRequest).not.toHaveBeenCalled();
    expect(component.applicationStatusKey('EXPIRED')).toBe('friend.expired');
  });

  it('retains a rejected application as a terminal record', async () => {
    const { component, groups } = create(vi.fn(() => of(response())));
    component.applications.set([row(1)]);
    await component.handleApplication(component.applications()[0], false);
    expect(groups.rejectJoinRequest).toHaveBeenCalledWith({
      groupId: 7,
      account: 'user-1',
      domain: 'local',
    });
    expect(component.applications()[0].status).toBe('REJECTED');
    expect(
      component.applicationStatusKey(component.applications()[0].status),
    ).toBe('friend.rejected');
  });
});
