import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { of, Subject } from 'rxjs';
import { HttpClient } from '@angular/common/http';
import { SessionLifecycleService } from '../../services/session-lifecycle.service';
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
import { IdentitySearchStatus } from '../../services/identity-search';
import { UserService } from '../../services/user.service';
import { type User, type StandardResponse } from '../../services/model';

const lookupUser: User = {
  id: 12,
  account: 'friend',
  namespaceId: 7,
  profileRev: 1,
  name: 'Friend',
  avatar: '',
  bio: '',
  isGroup: false,
  isDeleted: false,
};

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
    const openThreadId = signal<number | undefined>(7);
    const http = {
      get: vi.fn(() => of(new Blob(['x'], { type: 'image/webp' }))),
    };
    const users = {
      resolveUser: vi.fn(() =>
        of({ code: 0, message: 'ok', data: lookupUser }),
      ),
      searchUsers: vi.fn(),
      resolveFederatedUser: vi.fn(() => of({ user: lookupUser })),
    };
    const groups = {
      queryJoinRequests,
      queryInvitations: vi.fn(() => of(response())),
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
        { provide: HttpClient, useValue: http },
        {
          provide: ConversationListService,
          useValue: {
            openThreadId,
            items: () => [thread],
            markJoinRequestsReadLocally,
          },
        },
        { provide: UserService, useValue: users },
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
      users,
      http,
      openThreadId,
      markJoinRequestsReadLocally,
    };
  }

  it.each(['friend@remote.test', 'friend@local.test'])(
    'routes %s to exact lookup, without fuzzy search',
    (address) => {
      const { component, users } = create(vi.fn(() => of(response())));
      component.searchText.set(address);
      component.search();
      expect(users.searchUsers).not.toHaveBeenCalled();
      expect(users.resolveFederatedUser).toHaveBeenCalledWith(
        { account: 'friend', domain: address.split('@')[1] },
        expect.any(Function),
      );
      expect(component.lookup.results()[0]).toBe(lookupUser);
    },
  );

  it.each(['friend', 'a'])('resolves the exact local account %s', (query) => {
    const { component, users } = create(vi.fn(() => of(response())));
    component.searchText.set(query);
    component.search();
    expect(users.resolveUser).toHaveBeenCalledWith({ account: query });
    expect(users.searchUsers).not.toHaveBeenCalled();
    expect(users.resolveFederatedUser).not.toHaveBeenCalled();
    expect(component.lookup.results()).toEqual([lookupUser]);
  });

  it.each(['friend@', '@remote.test', 'friend@@remote.test', 'first last'])(
    'rejects malformed address %s without fuzzy fallback',
    (query) => {
      const { component, users } = create(vi.fn(() => of(response())));
      component.searchText.set(query);
      component.search();
      expect(users.searchUsers).not.toHaveBeenCalled();
      expect(users.resolveUser).not.toHaveBeenCalled();
      expect(users.resolveFederatedUser).not.toHaveBeenCalled();
      expect(component.lookup.errorKey()).toBe('friend.error.invalidAddress');
    },
  );

  it.each([0, 7])(
    'allows a resolved non-friend in namespace %s without altering the lookup snapshot',
    (namespaceId) => {
      const { component, groups } = create(vi.fn(() => of(response())));
      const candidate = { ...lookupUser, namespaceId };
      expect(component.invitationState(candidate)).toBe('AVAILABLE');
      expect(component.candidateActionKey(candidate)).toBe(
        'group.inviteAction',
      );
      component.invite(candidate);
      expect(groups.inviteUsers).toHaveBeenCalledWith({
        groupId: 7,
        users: [
          {
            account: candidate.account,
            namespaceId,
            snapshot: { displayName: candidate.name, avatar: null },
          },
        ],
      });
      expect(candidate).not.toHaveProperty('state');
    },
  );

  it.each(['!team', '!team@remote.test'])(
    'rejects group target %s',
    (query) => {
      const { component, users } = create(vi.fn(() => of(response())));
      const group = { ...lookupUser, account: '!team', isGroup: true };
      users.resolveUser.mockReturnValue(
        of({ code: 0, message: 'ok', data: group }),
      );
      users.resolveFederatedUser.mockReturnValue(of({ user: group }));
      component.searchText.set(query);
      component.search();
      expect(component.lookup.errorKey()).toBe('group.cannotInviteGroup');
      expect(component.lookup.results()).toEqual([]);
    },
  );

  it('derives pending invitation hints from both receiver coordinates and ignores expired rounds', () => {
    const { component } = create(vi.fn(() => of(response())));
    const invitation = {
      ...invitationRow('12', 'REQUESTED', lookupUser),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    component.invitations.set([invitation]);
    expect(component.invitationState(lookupUser)).toBe('INVITED');
    expect(component.invitationState({ ...lookupUser, namespaceId: 8 })).toBe(
      'AVAILABLE',
    );
    expect(component.invitationState({ ...lookupUser, account: 'other' })).toBe(
      'AVAILABLE',
    );
    component.invitations.set([
      { ...invitation, expiresAt: new Date(Date.now() - 1).toISOString() },
    ]);
    expect(component.invitationState(lookupUser)).toBe('AVAILABLE');
  });

  it.each(['ALREADY_MEMBER', 'ALREADY_INVITED'])(
    'shows the server business rejection %s without marking the request sent',
    (reason) => {
      const { component, groups } = create(vi.fn(() => of(response())));
      groups.inviteUsers.mockReturnValue(
        of({
          code: 0,
          message: 'ok',
          data: {
            invited: [],
            skipped: [
              { ...lookupUser, reason, code: 10002, message: 'already exists' },
            ],
          },
        }) as never,
      );
      component.invite(lookupUser);
      expect(TestBed.inject(ToastService).warn).toHaveBeenCalledWith(
        reason === 'ALREADY_MEMBER'
          ? 'group.alreadyMember'
          : 'group.invitedStatus',
      );
      expect(component.invitationState(lookupUser)).toBe('AVAILABLE');
    },
  );

  it('cancels a local lookup when a new address is submitted', () => {
    const { component, users } = create(vi.fn(() => of(response())));
    const pending = new Subject<{
      code: number;
      message: string;
      data: User;
    }>();
    users.resolveUser.mockReturnValue(pending);
    component.searchText.set('friend');
    component.search();
    expect(pending.observed).toBe(true);
    component.searchText.set('friend@remote.test');
    component.search();
    expect(pending.observed).toBe(false);
    expect(component.lookup.status()).toBe(IdentitySearchStatus.SUCCESS);
    expect(component.lookup.results()).toEqual([lookupUser]);
  });

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

  it('appends cursor pages once, preserves loaded rows on failure and retries the same cursor', async () => {
    const first = {
      ...response(applicationRow('20')),
      data: {
        ...response(applicationRow('20')).data,
        hasMore: true,
        before: '20',
      },
    };
    const pending = new Subject<ReturnType<typeof response>>();
    const query = vi
      .fn()
      .mockReturnValueOnce(of(first))
      .mockReturnValueOnce(pending);
    const { component } = create(query, true);
    await Promise.resolve();
    component.loadMoreRequests('APPLICATION');
    component.loadMoreRequests('APPLICATION');
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith({
      groupId: 7,
      before: '20',
      take: 20,
    });
    pending.error(new Error('offline'));
    await Promise.resolve();
    expect(component.applicationsError()).toBe(true);
    expect(component.applications().map((row) => row.id)).toEqual(['20']);
    query.mockReturnValueOnce(of(response(applicationRow('10'))));
    component.retryRequests('APPLICATION');
    await Promise.resolve();
    expect(query).toHaveBeenLastCalledWith({
      groupId: 7,
      before: '20',
      take: 20,
    });
    expect(component.applications().map((row) => row.id)).toEqual(['20', '10']);
    expect(component.applicationsError()).toBe(false);
    component.loadMoreRequests('APPLICATION');
    expect(query).toHaveBeenCalledTimes(3);
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

  it('invites a foreign non-friend by its address', async () => {
    const { component, groups } = create(vi.fn(() => of(response())));
    const candidate = {
      ...lookupUser,
      namespaceId: 7,
      profileRev: 1,
      account: 'friend',
      name: 'Friend',
      avatar: '',
      bio: '',
    };
    component.lookup.results.set([candidate]);
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
    component.invite(candidate);
    expect(groups.inviteUsers).toHaveBeenCalledWith({
      groupId: 7,
      users: [
        {
          account: 'friend',
          namespaceId: 7,
          snapshot: { displayName: 'Friend', avatar: null },
        },
      ],
    });
    expect(component.invitationState(component.lookup.results()[0])).toBe(
      'INVITED',
    );
  });

  it('freezes lookup-supplied display data at the invitation boundary', async () => {
    const { component, groups } = create(vi.fn(() => of(response())));
    component.invite({
      ...lookupUser,
      profileRev: 3,
      name: 'Published Friend',
      avatar: '/uploads/avatars/friend.webp',
    });
    await vi.waitFor(() =>
      expect(groups.inviteUsers).toHaveBeenCalledWith({
        groupId: 7,
        users: [
          {
            account: 'friend',
            namespaceId: 7,
            snapshot: {
              displayName: 'Published Friend',
              avatar: 'data:image/webp;base64,eA==',
            },
          },
        ],
      }),
    );
  });

  it('invites an unpublished candidate with the account-name fallback', async () => {
    const { component, groups } = create(vi.fn(() => of(response())));
    component.invite({ ...lookupUser, profileRev: 0, name: 'friend' });
    await vi.waitFor(() =>
      expect(groups.inviteUsers).toHaveBeenCalledWith({
        groupId: 7,
        users: [
          {
            account: 'friend',
            namespaceId: 7,
            snapshot: { displayName: 'friend', avatar: null },
          },
        ],
      }),
    );
  });

  it('cancels a pending avatar fetch on session invalidation, without sending an invitation', () => {
    const { component, groups, http } = create(vi.fn(() => of(response())));
    const pending = new Subject<Blob>();
    http.get.mockReturnValue(pending);
    const candidate = {
      ...lookupUser,
      profileRev: 3,
      name: 'Published Friend',
      avatar: '/uploads/avatars/friend.webp',
    };
    component.invite(candidate);
    component.invite(candidate);
    expect(http.get).toHaveBeenCalledTimes(1);
    expect(pending.observed).toBe(true);
    TestBed.inject(SessionLifecycleService).invalidateSession();
    expect(pending.observed).toBe(false);
    expect(groups.inviteUsers).not.toHaveBeenCalled();
    expect(component.inviting().size).toBe(0);
  });

  it('cancels a pending avatar fetch when the invite panel is destroyed', () => {
    const { component, groups, http } = create(vi.fn(() => of(response())));
    const pending = new Subject<Blob>();
    http.get.mockReturnValue(pending);
    component.invite({ ...lookupUser, avatar: '/uploads/avatars/friend.webp' });
    expect(pending.observed).toBe(true);
    TestBed.resetTestingModule();
    expect(pending.observed).toBe(false);
    expect(groups.inviteUsers).not.toHaveBeenCalled();
  });

  it('keeps a pending avatar fetch when the visible chat switches groups', async () => {
    const { component, groups, http, openThreadId } = create(
      vi.fn(() => of(response())),
    );
    const pending = new Subject<Blob>();
    http.get.mockReturnValue(pending);
    TestBed.tick();
    component.invite({ ...lookupUser, avatar: '/uploads/avatars/friend.webp' });
    openThreadId.set(8);
    TestBed.tick();
    // The invitation stays with its captured group; only destruction or
    // session end cancels the serialization or submission.
    expect(pending.observed).toBe(true);
    expect(component.inviting().size).toBe(1);
    pending.next(new Blob(['e'], { type: 'image/webp' }));
    pending.complete();
    await vi.waitFor(() =>
      expect(groups.inviteUsers).toHaveBeenCalledWith(
        expect.objectContaining({ groupId: 7 }),
      ),
    );
  });

  it('re-enables a foreign candidate by address after revoking its invitation', async () => {
    const { component, groups } = create(
      vi.fn(() => of(response())),
      true,
    );
    component.lookup.results.set([lookupUser]);
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
    expect(component.invitationState(component.lookup.results()[0])).toBe(
      'AVAILABLE',
    );
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
