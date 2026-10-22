import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TranslocoService } from '@jsverse/transloco';
import type {
  RequestDecisionResult,
  RequestRecord,
} from '../../../../../shared/relationship-request';
import { GroupJoinRequestsComponent } from './group-join-requests.component';
import { GroupService } from '../../services/group.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import { ToastService } from '../../services/toast.service';
import { UserService } from '../../services/user.service';
import type { StandardResponse } from '../../services/model';

function decisionResponse(
  data: RequestDecisionResult,
): StandardResponse<RequestDecisionResult> {
  return { code: 0, message: 'ok', data };
}

function applicationRow(
  requestId: string,
  status: RequestRecord['status'] = 'REQUESTED',
): RequestRecord {
  return {
    id: requestId,
    kind: 'GROUP_APPLICATION',
    author: { account: `user-${requestId}`, namespaceId: 0 },
    receiver: { account: 'managers', namespaceId: 0 },
    status,
    direction: 'INCOMING',
    authorProfile: {
      account: `user-${requestId}`,
      namespaceId: 0,
      profileNamespaceId: 0,
      profileRev: 1,
    },
    note: '',
    requestedAt: '2026-01-02T00:00:00Z',
    expiresAt: '2026-01-09T00:00:00Z',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  };
}

function invitationRow(
  requestId: string,
  status: RequestRecord['status'] = 'REQUESTED',
  receiver = { account: `user-${requestId}`, namespaceId: 0 },
): RequestRecord {
  return {
    id: requestId,
    kind: 'GROUP_INVITATION',
    author: { account: 'managers', namespaceId: 0 },
    receiver,
    status,
    direction: 'OUTGOING',
    snapshot: { displayName: receiver.account, avatar: null },
    note: '',
    requestedAt: '2026-01-02T00:00:00Z',
    expiresAt: '2026-01-09T00:00:00Z',
    createdAt: '2026-01-02T00:00:00Z',
    updatedAt: '2026-01-02T00:00:00Z',
  };
}

function response(item?: RequestRecord) {
  return {
    code: 0,
    data: {
      items: item ? [item] : [],
      hasMore: false,
      before: item?.id ?? null,
      joinRequestEndFeedId: 2,
      joinRequestReadFeedId: 2,
    },
  };
}

const decision = decisionResponse({ status: 'OK', threadId: null });

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
      acceptJoinRequest: vi.fn(() => of(decision)),
      rejectJoinRequest: vi.fn(() => of(decision)),
      revokeInvitation: vi.fn(() => of(decision)),
      inviteUsers: vi.fn(() =>
        of({
          code: 0,
          message: 'ok',
          data: {
            invited: [] as { account: string; namespaceId: number }[],
            skipped: [],
          },
        }),
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
    const queryJoinRequests = vi.fn(() => of(response(applicationRow('2'))));
    const { groups, markJoinRequestsReadLocally } = create(
      queryJoinRequests,
      true,
    );
    const component = TestBed.runInInjectionContext(
      () => new GroupJoinRequestsComponent(),
    );
    component.setTab(1);
    await Promise.resolve();
    expect(queryJoinRequests).toHaveBeenCalledWith({
      groupId: 7,
      before: undefined,
      take: 20,
    });
    expect(component.applications()).toEqual([applicationRow('2')]);
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
      name: 'Friend',
      avatar: '',
      bio: '',
      state: 'AVAILABLE' as const,
    };
    component.candidates.set([candidate]);
    groups.inviteUsers.mockReturnValue(
      of({
        code: 0,
        message: 'ok',
        data: {
          invited: [{ account: 'friend', namespaceId: 7 }],
          skipped: [],
        },
      }),
    );
    await component.invite(candidate);
    expect(groups.inviteUsers).toHaveBeenCalledWith({
      groupId: 7,
      users: [{ account: 'friend', namespaceId: 7, snapshot: { displayName: 'Friend', avatar: null } }],
    });
    expect(component.candidates()[0].state).toBe('INVITED');
  });

  it('re-enables a foreign candidate by address after revoking its invitation', async () => {
    const { component, groups } = create(vi.fn(() => of(response())), true);
    component.candidates.set([
      {
        threadId: 12,
        namespaceId: 7,
        profileRev: 1,
        account: 'friend',
        name: 'Friend',
        avatar: '',
        bio: '',
        state: 'INVITED',
      },
    ]);
    component.invitations.set([
      invitationRow('12', 'REQUESTED', {
        account: 'friend',
        namespaceId: 7,
      }),
    ]);
    await component.revokeInvitation(component.invitations()[0]);
    expect(groups.revokeInvitation).toHaveBeenCalledWith({
      groupId: 7,
      requestId: '12',
    });
    expect(component.candidates()[0].state).toBe('AVAILABLE');
    expect(component.invitations()[0].status).toBe('WITHDRAWN');
  });

  it('does not apply a stale decision as a local terminal state', async () => {
    // The stale reload restores the authoritative REQUESTED round, not a local terminal state.
    const { component, groups } = create(
      vi.fn(() => of(response(applicationRow('1')))),
    );
    component.applications.set([applicationRow('1')]);
    groups.rejectJoinRequest.mockReturnValue(
      of(decisionResponse({ status: 'STALE_REQUEST' })),
    );
    await component.handleApplication(component.applications()[0], false);
    expect(groups.rejectJoinRequest).toHaveBeenCalledWith({
      groupId: 7,
      requestId: '1',
    });
    expect(component.applications()[0].status).toBe('REQUESTED');
  });

  it('does not attribute a withdrawn or expired application to a manager rejection', async () => {
    const withdrawn = applicationRow('2', 'WITHDRAWN');
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
    component.applications.set([applicationRow('1')]);
    await component.handleApplication(component.applications()[0], false);
    expect(groups.rejectJoinRequest).toHaveBeenCalledWith({
      groupId: 7,
      requestId: '1',
    });
    expect(component.applications()[0].status).toBe('REJECTED');
    expect(
      component.applicationStatusKey(component.applications()[0].status),
    ).toBe('friend.rejected');
  });
});
