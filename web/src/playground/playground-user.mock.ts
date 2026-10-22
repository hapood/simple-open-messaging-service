import { Injectable, computed, inject, signal } from '@angular/core';
import { defer, of, map } from 'rxjs';
import type {
  IncomingRequestHead,
  RequestDecisionResult,
  RequestRecord,
} from '../../../shared/relationship-request';
import {
  createGroupConversation,
  type StandardResponse,
  type User,
} from '../app/services/model';
import {
  FederatedResolveError,
  UserService,
} from '../app/services/user.service';
import { PlaygroundSocialState, sameIdentity } from './playground-social-state';

type Args<K extends keyof UserService> = UserService[K] extends (
  ...args: infer A
) => unknown
  ? A
  : never;
type Result<K extends keyof UserService> = UserService[K] extends (
  ...args: never[]
) => infer R
  ? R
  : never;

/** Online request rounds and thread relationships, without a backend or legacy local request cache. */
@Injectable({ providedIn: 'root' })
export class PlaygroundUserService
  implements
    Pick<
      UserService,
      | 'sessionUserId'
      | 'sessionProfile'
      | 'relationshipRequestHead'
      | 'friendReqBadge'
      | 'resolveUser'
      | 'resolveFederatedUser'
      | 'localRelationship'
      | 'hasPendingGroupApplication'
      | 'queryRelationshipRequests'
      | 'observeIncomingRequestPage'
      | 'markRelationshipRequestsRead'
      | 'requestRelationship'
      | 'acceptRelationship'
      | 'joinGroupRequest'
      | 'rejectRelationshipRequest'
      | 'withdrawRelationshipRequest'
      | 'revokeRelationship'
    >
{
  private readonly state = inject(PlaygroundSocialState);
  readonly sessionUserId = signal<number | null>(1);
  readonly sessionProfile = signal<User | undefined>({ ...this.state.self });
  readonly relationshipRequestHead = this.state.incomingHead.asReadonly();
  readonly friendReqBadge = computed(() => {
    const head = this.relationshipRequestHead();
    return BigInt(head.requestEndId) > BigInt(head.requestReadId);
  });

  resolveUser(...[params]: Args<'resolveUser'>): Result<'resolveUser'> {
    return defer(() => {
      const user = this.state.user(params.account);
      return of(
        user
          ? { code: 0, message: 'ok', data: { ...user } }
          : { code: 404, message: 'User not found' },
      );
    });
  }

  resolveFederatedUser(
    ...[params, onProgress]: Args<'resolveFederatedUser'>
  ): Result<'resolveFederatedUser'> {
    return defer(() => {
      onProgress?.('DISCOVERING');
      if (params.domain !== 'chat.example.test')
        throw new FederatedResolveError('NOT_FOUND');
      const user = this.state.user(params.account);
      if (!user) throw new FederatedResolveError('NOT_FOUND');
      onProgress?.('FETCHING_USER');
      return of({ user: { ...user } });
    });
  }

  async localRelationship(
    ...[user]: Args<'localRelationship'>
  ): Result<'localRelationship'> {
    if (this.activeThread(user)) return 'FRIEND';
    if (user.account.startsWith('!')) return 'NONE';
    for (const direction of ['OUTGOING', 'INCOMING'] as const) {
      if (
        this.state.requests.some(
          ({ record, groupId }) =>
            groupId === undefined &&
            record.kind === 'FRIEND' &&
            record.direction === direction &&
            this.state.status(record) === 'REQUESTED' &&
            sameIdentity(
              direction === 'OUTGOING' ? record.receiver : record.author,
              user,
            ),
        )
      )
        return direction === 'OUTGOING'
          ? 'OUTGOING_PENDING'
          : 'INCOMING_PENDING';
    }
    return 'NONE';
  }

  async hasPendingGroupApplication(
    ...[target]: Args<'hasPendingGroupApplication'>
  ): Result<'hasPendingGroupApplication'> {
    return this.state.requests.some(
      ({ record, groupId }) =>
        groupId === undefined &&
        record.kind === 'GROUP_APPLICATION' &&
        record.direction === 'OUTGOING' &&
        sameIdentity(record.receiver, target) &&
        this.state.status(record) === 'REQUESTED',
    );
  }

  queryRelationshipRequests(
    ...[params]: Args<'queryRelationshipRequests'>
  ): Result<'queryRelationshipRequests'> {
    return defer(() =>
      of({
        code: 0,
        message: 'ok',
        data: {
          ...this.state.page(
            this.state.requests
              .filter(
                ({ record, groupId }) =>
                  groupId === undefined &&
                  record.direction ===
                    (params.bucket === 'RECEIVED' ? 'INCOMING' : 'OUTGOING'),
              )
              .map(({ record }) => record),
            params,
          ),
          incomingHead: { ...this.relationshipRequestHead() },
        },
      }),
    );
  }

  async observeIncomingRequestPage(head: IncomingRequestHead): Promise<void> {
    await this.markRelationshipRequestsRead(head.requestEndId);
  }

  async markRelationshipRequestsRead(requestReadId: string): Promise<void> {
    this.state.incomingHead.update((head) => ({
      ...head,
      requestReadId: String(
        BigInt(requestReadId) > BigInt(head.requestReadId)
          ? BigInt(requestReadId) < BigInt(head.requestEndId)
            ? BigInt(requestReadId)
            : BigInt(head.requestEndId)
          : BigInt(head.requestReadId),
      ),
    }));
  }

  requestRelationship(
    ...[params]: Args<'requestRelationship'>
  ): Result<'requestRelationship'> {
    return defer(() => {
      const target = this.state.user(params.account, params.namespaceId);
      if (!target || sameIdentity(target, this.state.self))
        return of({ code: 400, message: 'Invalid target' });
      const thread = this.activeThread(target);
      if (thread)
        return of({
          code: 0,
          message: 'ok',
          data: target.isGroup
            ? { status: 'NO_OP' as const, reason: 'ALREADY_MEMBER' }
            : { status: 'OK' as const, threadId: thread.threadId },
        });
      // A live reverse request is reciprocal consent, not another pending outgoing round.
      const reverse = this.state.requests.find(
        ({ record, groupId }) =>
          groupId === undefined &&
          record.direction === 'INCOMING' &&
          sameIdentity(record.author, target) &&
          this.state.status(record) === 'REQUESTED',
      );
      if (reverse)
        return this.decide(reverse.record.id, 'INCOMING', 'ACCEPTED').pipe(
          map((response) => ({
            code: response.code,
            message: response.message,
            data: target.isGroup
              ? { status: 'APPLIED' as const }
              : {
                  status: 'OK' as const,
                  ...(response.data?.status === 'OK' &&
                  response.data.threadId !== null
                    ? { threadId: response.data.threadId }
                    : {}),
                },
          })),
        );
      const kind = target.isGroup ? 'GROUP_APPLICATION' : 'FRIEND';
      const pending = this.state.requests.find(
        ({ record, groupId }) =>
          groupId === undefined &&
          record.kind === kind &&
          record.direction === 'OUTGOING' &&
          sameIdentity(record.receiver, target) &&
          this.state.status(record) === 'REQUESTED',
      );
      if (!pending)
        this.state.addRequest(
          kind,
          this.state.self,
          target,
          'OUTGOING',
          undefined,
          params.note,
          params.snapshot,
        );
      return of({
        code: 0,
        message: 'ok',
        data: {
          status: target.isGroup ? ('APPLIED' as const) : ('OK' as const),
        },
      });
    });
  }

  acceptRelationship(
    ...[params]: Args<'acceptRelationship'>
  ): Result<'acceptRelationship'> {
    return this.decide(params.requestId, 'INCOMING', 'ACCEPTED');
  }
  joinGroupRequest(
    ...[params]: Args<'joinGroupRequest'>
  ): Result<'joinGroupRequest'> {
    return this.decide(
      params.requestId,
      'INCOMING',
      'ACCEPTED',
      'GROUP_INVITATION',
    );
  }
  rejectRelationshipRequest(
    ...[params]: Args<'rejectRelationshipRequest'>
  ): Result<'rejectRelationshipRequest'> {
    return this.decide(params.requestId, 'INCOMING', 'REJECTED');
  }
  withdrawRelationshipRequest(
    ...[params]: Args<'withdrawRelationshipRequest'>
  ): Result<'withdrawRelationshipRequest'> {
    return this.decide(params.requestId, 'OUTGOING', 'WITHDRAWN');
  }

  revokeRelationship(
    ...[params]: Args<'revokeRelationship'>
  ): Result<'revokeRelationship'> {
    return defer(() => {
      const thread = this.state.conversations
        .items()
        .find((item) => item.threadId === params.threadId);
      if (thread?.type !== 'P2P')
        return of({ code: 400, message: 'Not a friendship thread' });
      this.state.conversations.applyThreadMeta(thread.threadId, {
        friendshipActive: false,
        conversationState: 'READ_ONLY',
      });
      return of({ code: 0, message: 'ok', data: { status: 'OK' as const } });
    });
  }

  private activeThread(user: { account: string; namespaceId: number }) {
    return this.state.conversations
      .items()
      .find((item) =>
        item.type === 'P2P'
          ? item.friendshipActive !== false && sameIdentity(item.peerUser, user)
          : item.conversationState !== 'READ_ONLY' &&
            !item.group.dissolvedAt &&
            sameIdentity(item.group, user),
      );
  }

  private decide(
    requestId: string,
    direction: RequestRecord['direction'],
    status: 'ACCEPTED' | 'REJECTED' | 'WITHDRAWN',
    kind?: RequestRecord['kind'],
  ) {
    return defer(() => {
      const record = this.state.requests.find(
        (item) => item.groupId === undefined && item.record.id === requestId,
      )?.record;
      let data: RequestDecisionResult;
      if (
        !record ||
        record.direction !== direction ||
        (kind && record.kind !== kind) ||
        !['REQUESTED', 'EXPIRED'].includes(this.state.status(record))
      )
        data = { status: 'STALE_REQUEST' };
      else if (this.state.status(record) === 'EXPIRED')
        data = { status: 'EXPIRED' };
      else {
        let threadId: number | null = null;
        if (status === 'ACCEPTED') {
          const user = this.state.user(
            record.author.account,
            record.author.namespaceId,
          )!;
          if (record.kind === 'FRIEND')
            threadId = this.state.activateFriend(user);
          else {
            threadId =
              this.state.conversations
                .items()
                .find(
                  (item) =>
                    item.type === 'GROUP' && sameIdentity(item.group, user),
                )?.threadId ?? this.state.allocateThreadId();
            this.state.conversations.setRelatedConversations([
              createGroupConversation(
                threadId,
                {
                  id: threadId,
                  account: user.account,
                  name: user.name,
                  namespaceId: user.namespaceId,
                  profileRev: 1,
                  memberCount: 1,
                  groupMetaFeedId: '1',
                  announcement: { feedId: '1', text: null },
                },
                { role: 'MEMBER', groupMetaTargetFeedId: '1' },
              ),
            ]);
            this.state.rosters.set(threadId, [
              this.state.member(this.state.self),
            ]);
          }
        }
        this.state.settle(record, status);
        data = { status: 'OK', threadId };
      }
      return of<StandardResponse<RequestDecisionResult>>({
        code: 0,
        message: 'ok',
        data,
      });
    });
  }
}
