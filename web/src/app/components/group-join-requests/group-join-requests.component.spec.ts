import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
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
    domain: '',
    name: `User ${feedId}`,
    avatar: '',
    note: '',
    requestedAt: null,
    expiresAt: null,
  } satisfies GroupJoinRequest;
}

function response(item: GroupJoinRequest) {
  return {
    code: 0,
    data: { data: [item], hasMore: false, before: item.feedId },
  };
}

describe('GroupJoinRequestsComponent', () => {
  function create(queryJoinRequests: ReturnType<typeof vi.fn>) {
    const groups = {
      queryJoinRequests,
      markJoinRequestsRead: vi.fn(() => of({ code: 0 })),
      acceptJoinRequest: vi.fn(() => of({ code: 0 })),
      rejectJoinRequest: vi.fn(() => of({ code: 0 })),
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
        { provide: NavStateMachineService, useValue: { closeAside: vi.fn() } },
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

  it('ignores an older reset response that completes after a newer one', async () => {
    const older = new Subject<ReturnType<typeof response>>();
    const newer = new Subject<ReturnType<typeof response>>();
    const { component } = create(
      vi.fn().mockReturnValueOnce(older).mockReturnValueOnce(newer),
    );
    const refresh = (
      component as unknown as { load(append: boolean): Promise<void> }
    ).load(false);
    newer.next(response(row(2)));
    newer.complete();
    await refresh;
    older.next(response(row(1)));
    older.complete();
    await Promise.resolve();
    expect(component.requests()).toEqual([row(2)]);
  });

  it('retains a rejected request and invalidates a captured list response', async () => {
    const captured = new Subject<ReturnType<typeof response>>();
    const { component } = create(vi.fn(() => captured));
    component.requests.set([row(1)]);
    await component.act('1', false);
    expect(component.requests()[0].status).toBe('REVOKED');
    captured.next(response(row(1)));
    captured.complete();
    await Promise.resolve();
    expect(component.requests()[0].status).toBe('REVOKED');
  });
});
