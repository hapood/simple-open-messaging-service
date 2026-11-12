import { Injectable, inject } from '@angular/core';
import { defer, of } from 'rxjs';
import type {
  GroupRequestPage,
  RequestDecisionResult,
  RequestRecord,
} from '../../../shared/relationship-request';
import { GroupService } from '../app/services/group.service';
import { BusinessCode } from '../app/services/biz-code';
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
        createGroupConversation({
          threadId: id,
          account,
          publisherNamespaceId: 0,
          profileRev: 1,
          profile: {
            name: params.name,
            bio: params.description ?? '',
            avatarDigest: null,
          },
          meta: {
            memberCount: 1,
            groupMetaFeedId: '1',
            announcementFeedId: '1',
            announcementText: null,
          },
          role: 'OWNER',
          groupMetaFeedEndId: '1',
          joinRequestEndFeedId: 0,
          joinRequestReadFeedId: 0,
        }),
      ]);
      this.state.rosters.set(id, [this.state.member(this.state.self, 'OWNER')]);
      return of(ok({ threadId: id, groupId: id }));
    });
  }

  updateGroup(...[params]: Args<'updateGroup'>): Result<'updateGroup'> {
    return defer(() => {
      this.requireManager(params.groupId);
      const { groupId } = params;
      const profile = { ...this.group(groupId).profile };
      if (params.name !== undefined) profile.name = params.name;
      if (params.description !== undefined) profile.bio = params.description;
      this.state.conversations.applyGroupUpdate(groupId, { profile });
      const thread = this.group(groupId);
      const user = this.state.user(thread.account, thread.publisherNamespaceId);
      if (user) {
        this.state.publishProfile(user, {
          name: thread.profile.name,
          bio: thread.profile.bio ?? '',
          avatar: params.avatar ?? user.avatar,
        });
        this.state.conversations.applyThreadMeta(groupId, {
          profileRev: user.profileRev,
        });
      }
      return of(ok(undefined));
    });
  }

  inviteUsers(...[params]: Args<'inviteUsers'>): Result<'inviteUsers'> {
    return defer(() => {
      this.requireManager(params.groupId);
      const conversation = this.group(params.groupId);
      const invited: Array<{ account: string; namespaceId: number }> = [];
      const skipped: Array<{
        account: string;
        namespaceId: number;
        reason: string;
        code: number;
        message: string;
      }> = [];
      for (const target of params.users) {
        const friend = this.state.conversations.items().find(
          (thread) =>
            thread.type === 'P2P' &&
            thread.conversationState === 'ACTIVE' &&
            !thread.blocked &&
            sameIdentity(
              {
                account: thread.account,
                namespaceId: thread.publisherNamespaceId,
              },
              target,
            ),
        );
        const reason = !friend
          ? 'FRIEND_REQUIRED'
          : this.candidateState(params.groupId, target);
        if (reason !== 'AVAILABLE') {
          skipped.push({
            account: target.account,
            namespaceId: target.namespaceId,
            reason:
              reason === 'MEMBER'
                ? 'ALREADY_MEMBER'
                : reason === 'INVITED'
                  ? 'ALREADY_INVITED'
                  : reason,
            code:
              reason === 'FRIEND_REQUIRED'
                ? BusinessCode.GROUP_FORBIDDEN
                : BusinessCode.ALREADY_EXISTS,
            message: reason,
          });
          continue;
        }
        this.state.addRequest(
          'GROUP_INVITATION',
          {
            account: conversation.account,
            namespaceId: conversation.publisherNamespaceId,
          },
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
      const feedId = Number(this.group(groupId).meta.groupMetaFeedId) + 1;
      this.state.conversations.applyGroupUpdate(groupId, {
        meta: {
          groupMetaFeedId: String(feedId),
          announcementFeedId: String(feedId),
          announcementText: text,
          announcementCreatedAt: Date.now(),
          announcementOriginCreatedAt: null,
        },
      });
      this.state.conversations.applyThreadMeta(groupId, {
        groupMetaFeedEndId: String(feedId),
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
  ): 'AVAILABLE' | 'INVITED' | 'MEMBER' {
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
