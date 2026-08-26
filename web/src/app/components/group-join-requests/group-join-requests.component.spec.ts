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
    id: String(feedId),
    status,
    userId: feedId,
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
  function create(queryJoinRequests: ReturnType<typeof vi.fn>) {
    const groups = {
      queryJoinRequests,
      queryInvitations: vi.fn(() => of(response())),
      queryInviteCandidates: vi.fn(() =>
        of({
          code: 0,
          data: { data: [], hasMore: false, afterUserId: null },
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
          useValue: { openThreadId: () => 7 },
        },
        {
          provide: UserService,
          useValue: {
            groupJoinRequestHeads: () => new Map(),
            markGroupJoinRequestsRead: vi.fn(),
          },
        },
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
    };
  }

  it('loads applications when the application tab opens', async () => {
    const queryJoinRequests = vi.fn(() => of(response(row(2))));
    const { component } = create(queryJoinRequests);
    component.setTab(1);
    await Promise.resolve();
    expect(queryJoinRequests).toHaveBeenCalledWith({
      groupId: 7,
      before: undefined,
      take: 20,
    });
    expect(component.applications()).toEqual([row(2)]);
  });

  it('retains a rejected application as a terminal record', async () => {
    const { component } = create(vi.fn(() => of(response())));
    component.applications.set([row(1)]);
    await component.handleApplication('1', false);
    expect(component.applications()[0].status).toBe('REVOKED');
  });
});
