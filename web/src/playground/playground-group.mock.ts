import { Injectable, inject } from '@angular/core';
import { defer, of } from 'rxjs';
import type {
  GroupRequestPage,
  RequestDecisionResult,
  RequestRecord,
} from '../../../shared/relationship-request';
import {
  GroupService,
  type GroupInviteCandidate,
} from '../app/services/group.service';
import {
  createGroupConversation,
  type StandardResponse,
} from '../app/services/model';
import { PlaygroundSocialState, sameIdentity } from './playground-social-state';

type Args<K extends keyof GroupService> = GroupService[K] extends (
  ...args: infer A
) => unknown
  ? A
  : never;
type Result<K extends keyof GroupService> = GroupService[K] extends (
  ...args: never[]
) => infer R
  ? R
  : never;
const ok = <T>(data: T): StandardResponse<T> => ({
  code: 0,
  message: 'ok',
  data,
});

/** Typed against every public group operation so service contract changes cannot silently drift. */
@Injectable({ providedIn: 'root' })
export class PlaygroundGroupService
  implements Pick<GroupService, keyof GroupService>
{
  private readonly state = inject(PlaygroundSocialState);

  createGroup(...[params]: Args<'createGroup'>): Result<'createGroup'> {
    return defer(() => {
      const id = this.state.allocateThreadId();
      const account = `!group${id}`;
      this.state.users.push({
        id,
        account,
        name: params.name,
        bio: params.description ?? '',
        avatar: params.avatar ?? '',
        namespaceId: 0,
        profileRev: 1,
        isGroup: true,
        isDeleted: false,
      });
      this.state.conversations.setRelatedConversations([
        createGroupConversation(
          id,
          {
            ...params,
            id,
            account,
            namespaceId: 0,
            memberCount: 1,
            profileRev: 1,
            groupMetaFeedId: '1',
            announcement: { feedId: '1', text: null },
          },
          {
            role: 'OWNER',
            groupMetaTargetFeedId: '1',
            joinRequestEndFeedId: 0,
            joinRequestReadFeedId: 0,
          },
        ),
      ]);
      this.state.rosters.set(id, [this.state.member(this.state.self, 'OWNER')]);
      return of(ok({ threadId: id, groupId: id }));
    });
  }

  updateGroup(...[params]: Args<'updateGroup'>): Result<'updateGroup'> {
    return defer(() => {
      this.requireManager(params.groupId);
      const { groupId, ...fields } = params;
      const patch = Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== undefined),
      );
      this.state.conversations.applyGroupUpdate(groupId, patch);
      const thread = this.group(groupId);
      const user = this.state.user(
        thread.group.account,
        thread.group.namespaceId,
      );
      if (user) {
        Object.assign(user, {
          name: thread.group.name,
          bio: thread.group.description,
          avatar: thread.group.avatar,
        });
        user.profileRev++;
        this.state.conversations.applyThreadMeta(groupId, {
          profileRev: user.profileRev,
        });
      }
      return of(ok(undefined));
    });
  }

  queryInviteCandidates(
    ...[params]: Args<'queryInviteCandidates'>
  ): Result<'queryInviteCandidates'> {
    return defer(() => {
      this.requireManager(params.groupId);
      const search = params.search?.trim().toLowerCase() ?? '';
      const rows: GroupInviteCandidate[] = this.state.conversations
        .items()
        .flatMap((thread) => {
          if (
            thread.type !== 'P2P' ||
            thread.friendshipActive === false ||
            thread.blocked ||
            thread.threadId <= (params.afterThreadId ?? 0)
          )
            return [];
          const user = this.state.user(
            thread.peerUser.account,
            thread.peerUser.namespaceId,
          )!;
          if (
            search &&
            !`${user.account} ${user.name}`.toLowerCase().includes(search)
          )
            return [];
          return [
            {
              threadId: thread.threadId,
              namespaceId: user.namespaceId,
              profileRev: user.profileRev,
              account: user.account,
              name: user.name,
              avatar: user.avatar,
              bio: user.bio,
              state: this.candidateState(params.groupId, user),
            },
          ];
        })
        .sort((a, b) => a.threadId! - b.threadId!);
      const data = rows.slice(0, Math.max(1, Math.min(50, params.take ?? 20)));
      const hasMore = rows.length > data.length;
      return of(
        ok({
          data,
          hasMore,
          afterThreadId: hasMore ? data.at(-1)!.threadId! : null,
        }),
      );
    });
  }

  inviteUsers(...[params]: Args<'inviteUsers'>): Result<'inviteUsers'> {
    return defer(() => {
      this.requireManager(params.groupId);
      const group = this.group(params.groupId).group;
      const invited: Array<{ account: string; namespaceId: number }> = [];
      const skipped: Array<{
        account: string;
        namespaceId: number;
        reason: string;
        code: string;
        message: string;
      }> = [];
      for (const target of params.users) {
        const friend = this.state.conversations
          .items()
          .find(
            (thread) =>
              thread.type === 'P2P' &&
              thread.friendshipActive !== false &&
              !thread.blocked &&
              sameIdentity(thread.peerUser, target),
          );
        const reason = !friend
          ? 'FRIEND_REQUIRED'
          : this.candidateState(params.groupId, target);
        if (reason !== 'AVAILABLE') {
          skipped.push({
            account: target.account,
            namespaceId: target.namespaceId,
            reason,
            code: reason,
            message: reason,
          });
          continue;
        }
        this.state.addRequest(
          'GROUP_INVITATION',
          group,
          target,
          'OUTGOING',
          params.groupId,
          '',
          target.snapshot,
        );
        invited.push({
          account: target.account,
          namespaceId: target.namespaceId,
        });
      }
      return of(ok({ invited, skipped }));
    });
  }

  queryJoinRequests(
    ...[params]: Args<'queryJoinRequests'>
  ): Result<'queryJoinRequests'> {
    return this.queryRequests(params, 'GROUP_APPLICATION');
  }
  queryInvitations(
    ...[params]: Args<'queryInvitations'>
  ): Result<'queryInvitations'> {
    return this.queryRequests(params, 'GROUP_INVITATION');
  }
  markJoinRequestsRead(
    ...[params]: Args<'markJoinRequestsRead'>
  ): Result<'markJoinRequestsRead'> {
    return defer(() => {
      this.requireManager(params.groupId);
      this.state.conversations.markJoinRequestsReadLocally(
        params.groupId,
        params.joinRequestReadFeedId,
      );
      return of(ok(undefined));
    });
  }
  acceptJoinRequest(
    ...[params]: Args<'acceptJoinRequest'>
  ): Result<'acceptJoinRequest'> {
    return this.decide(params, 'GROUP_APPLICATION', 'ACCEPTED');
  }
  rejectJoinRequest(
    ...[params]: Args<'rejectJoinRequest'>
  ): Result<'rejectJoinRequest'> {
    return this.decide(params, 'GROUP_APPLICATION', 'REJECTED');
  }
  revokeInvitation(
    ...[params]: Args<'revokeInvitation'>
  ): Result<'revokeInvitation'> {
    return this.decide(params, 'GROUP_INVITATION', 'WITHDRAWN');
  }

  setRole(...[params]: Args<'setRole'>): Result<'setRole'> {
    return defer(() => {
      this.requireOwner(params.groupId);
      const member = this.state.rosters
        .get(params.groupId)
        ?.find((member) => sameIdentity(member, params));
      if (!member || member.role === 'OWNER' || member.namespaceId !== 0)
        return of(
          ok({ status: 'REJECTED' as const, reason: 'INVALID_TARGET' }),
        );
      if (member.role === params.role)
        return of(
          ok({ status: 'NO_OP' as const, reason: 'ROLE_UNCHANGED' as const }),
        );
      member.role = params.role;
      this.state.publishRoster(params.groupId);
      return of(ok({ status: 'APPLIED' as const }));
    });
  }
  transferOwnership(
    ...[params]: Args<'transferOwnership'>
  ): Result<'transferOwnership'> {
    return defer(() => {
      this.requireOwner(params.groupId);
      const roster = this.state.rosters.get(params.groupId)!;
      const target = roster.find((member) => sameIdentity(member, params));
      if (!target || target.role === 'OWNER' || target.namespaceId !== 0)
        return of(
          ok({ status: 'REJECTED' as const, reason: 'INVALID_TARGET' }),
        );
      for (const member of roster) {
        if (member.role === 'OWNER') member.role = 'ADMIN';
        if (member === target) member.role = 'OWNER';
        member.isOwner = member.role === 'OWNER';
      }
      this.state.conversations.applyThreadMeta(params.groupId, {
        role: 'ADMIN',
      });
      this.state.publishRoster(params.groupId);
      return of(ok({ status: 'APPLIED' as const }));
    });
  }
  kickMember(...[params]: Args<'kickMember'>): Result<'kickMember'> {
    return defer(() => {
      this.requireManager(params.groupId);
      const thread = this.group(params.groupId);
      const roster = this.state.rosters.get(params.groupId)!;
      const target = roster.find((member) => sameIdentity(member, params));
      if (!target)
        return of(
          ok({ status: 'NO_OP' as const, reason: 'ALREADY_REVOKED' as const }),
        );
      if (
        target.role === 'OWNER' ||
        sameIdentity(target, this.state.self) ||
        (thread.role === 'ADMIN' && target.role !== 'MEMBER')
      )
        throw new Error('Cannot remove this member');
      this.state.rosters.set(
        params.groupId,
        roster.filter((member) => member !== target),
      );
      this.state.publishRoster(params.groupId);
      return of(ok({ status: 'APPLIED' as const }));
    });
  }
  leaveGroup(...[params]: Args<'leaveGroup'>): Result<'leaveGroup'> {
    return defer(() => {
      const thread = this.group(params.groupId);
      if (thread.role === 'OWNER')
        throw new Error('Transfer ownership before leaving');
      if (thread.conversationState === 'READ_ONLY')
        return of(
          ok({ status: 'NO_OP' as const, reason: 'ALREADY_REVOKED' as const }),
        );
      this.state.rosters.set(
        params.groupId,
        (this.state.rosters.get(params.groupId) ?? []).filter(
          (member) => !sameIdentity(member, this.state.self),
        ),
      );
      this.state.conversations.applyThreadMeta(params.groupId, {
        role: null,
        conversationState: 'READ_ONLY',
        joinRequestReadFeedId: -1,
      });
      this.state.publishRoster(params.groupId);
      return of(ok({ status: 'APPLIED' as const }));
    });
  }
  dissolveGroup(...[params]: Args<'dissolveGroup'>): Result<'dissolveGroup'> {
    return defer(() => {
      this.requireOwner(params.groupId);
      this.state.conversations.applyGroupUpdate(params.groupId, {
        dissolvedAt: Date.now(),
      });
      this.state.conversations.applyThreadMeta(params.groupId, {
        conversationState: 'READ_ONLY',
        joinRequestReadFeedId: -1,
      });
      return of(
        ok({
          taskId: `playground-dissolve-${params.groupId}`,
          status: 'PENDING' as const,
        }),
      );
    });
  }

  setAnnouncement(
    ...[groupId, text]: Args<'setAnnouncement'>
  ): Result<'setAnnouncement'> {
    return defer(() => {
      this.requireManager(groupId);
      const feedId = Number(this.group(groupId).group.groupMetaFeedId) + 1;
      this.state.conversations.applyGroupUpdate(groupId, {
        groupMetaFeedId: String(feedId),
        announcement: { feedId: String(feedId), text },
      });
      this.state.conversations.applyThreadMeta(groupId, {
        groupMetaTargetFeedId: String(feedId),
      });
      return of(ok({ feedId }));
    });
  }
  markAnnouncementRead(
    ...[groupId, feedId]: Args<'markAnnouncementRead'>
  ): Result<'markAnnouncementRead'> {
    return defer(() => {
      this.group(groupId);
      this.state.conversations.markAnnouncementReadLocally(groupId, feedId);
      return of(
        ok({
          announcementReadFeedId:
            this.group(groupId).announcementReadFeedId ?? 0,
        }),
      );
    });
  }

  private group(groupId: number) {
    const thread = this.state.conversations
      .items()
      .find((item) => item.threadId === groupId);
    if (thread?.type !== 'GROUP') throw new Error('Group not found');
    return thread;
  }
  private requireManager(groupId: number): void {
    const thread = this.group(groupId);
    if (
      thread.conversationState === 'READ_ONLY' ||
      thread.group.dissolvedAt ||
      !['OWNER', 'ADMIN'].includes(thread.role ?? '')
    )
      throw new Error('Active group manager required');
  }
  private requireOwner(groupId: number): void {
    this.requireManager(groupId);
    if (this.group(groupId).role !== 'OWNER')
      throw new Error('Group owner required');
  }
  private candidateState(
    groupId: number,
    target: { account: string; namespaceId: number },
  ): GroupInviteCandidate['state'] {
    if (
      this.state.rosters
        .get(groupId)
        ?.some((member) => sameIdentity(member, target))
    )
      return 'MEMBER';
    if (
      this.state.requests.some(
        (item) =>
          item.groupId === groupId &&
          item.record.kind === 'GROUP_INVITATION' &&
          sameIdentity(item.record.receiver, target) &&
          this.state.status(item.record) === 'REQUESTED',
      )
    )
      return 'INVITED';
    return 'AVAILABLE';
  }
  private queryRequests(
    params: { groupId: number; before?: string; take?: number },
    kind: RequestRecord['kind'],
  ) {
    return defer(() => {
      this.requireManager(params.groupId);
      const group = this.group(params.groupId);
      return of(
        ok<GroupRequestPage>({
          ...this.state.page(
            this.state.requests
              .filter(
                (item) =>
                  item.groupId === params.groupId && item.record.kind === kind,
              )
              .map((item) => item.record),
            params,
          ),
          joinRequestEndFeedId: group.joinRequestEndFeedId ?? 0,
          joinRequestReadFeedId: group.joinRequestReadFeedId ?? 0,
        }),
      );
    });
  }
  private decide(
    params: { groupId: number; requestId: string },
    kind: RequestRecord['kind'],
    status: 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN',
  ) {
    return defer(() => {
      this.requireManager(params.groupId);
      const record = this.state.requests.find(
        (item) =>
          item.groupId === params.groupId &&
          item.record.id === params.requestId &&
          item.record.kind === kind,
      )?.record;
      let data: RequestDecisionResult;
      if (
        !record ||
        !['REQUESTED', 'EXPIRED'].includes(this.state.status(record))
      )
        data = { status: 'STALE_REQUEST' };
      else if (this.state.status(record) === 'EXPIRED')
        data = { status: 'EXPIRED' };
      else {
        this.state.settle(record, status);
        if (status === 'ACCEPTED')
          this.state.addMember(
            params.groupId,
            this.state.user(record.author.account, record.author.namespaceId)!,
          );
        data = {
          status: 'OK',
          threadId: status === 'ACCEPTED' ? params.groupId : null,
        };
      }
      return of(ok(data));
    });
  }
}
