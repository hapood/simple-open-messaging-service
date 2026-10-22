import { Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type {
  RequestEndpoint,
  RequestKind,
  RequestRecord,
  RequestPage,
} from '../../../shared/relationship-request';
import type { RequestSnapshot } from '../../../shared/request-snapshot';
import {
  createGroupConversation,
  createP2PConversation,
  messageCreatorKey,
  type User,
} from '../app/services/model';
import type { ResolvedMemberProfile } from '../app/services/member-profile-store.service';
import { PlaygroundConversationList } from './playground-conversation-list.mock';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const sameIdentity = (a: RequestEndpoint, b: RequestEndpoint) =>
  a.account === b.account && a.namespaceId === b.namespaceId;

/** Shared in-memory server/projection state. Reloading the standalone entry resets all fixtures. */
@Injectable({ providedIn: 'root' })
export class PlaygroundSocialState {
  readonly conversations = inject(PlaygroundConversationList);
  readonly membersChanged$ = new Subject<readonly number[]>();
  readonly users: User[] = [
    'me',
    'alice',
    'maya',
    'noah',
    'olivia',
    'liam',
    'emma',
    'ivy',
    'jack',
    'zoe',
    '!playground',
    '!bookclub',
  ].map((account, index) => ({
    id: index + 1,
    account,
    name:
      account === '!playground'
        ? 'Playground Team'
        : account === '!bookclub'
          ? 'Book Club'
          : account[0].toUpperCase() + account.slice(1),
    avatar: '',
    bio: '',
    namespaceId: 0,
    profileRev: 1,
    isDeleted: false,
    isGroup: account.startsWith('!'),
  }));
  readonly self = this.users[0];
  readonly requests: Array<{ record: RequestRecord; groupId?: number }> = [];
  readonly incomingHead = signal({ requestEndId: '0', requestReadId: '0' });
  readonly rosters = new Map<number, ResolvedMemberProfile[]>();
  private nextRequestId = 9007199254740993n;
  private nextThreadId = 20;
  private initialized = false;

  initialize(): void {
    if (this.initialized) return;
    this.initialized = true;
    this.activateFriend(this.user('alice')!, 1);
    this.activateFriend(this.user('liam')!, 6);
    this.conversations.setRelatedConversations([
      createGroupConversation(
        2,
        {
          id: 2,
          account: '!playground',
          name: 'Playground Team',
          namespaceId: 0,
          description: 'Alice · Maya · Noah · Olivia · You',
          memberCount: 5,
          profileRev: 1,
          groupMetaFeedId: '1',
          announcement: { feedId: '1', text: null },
        },
        {
          role: 'OWNER',
          groupMetaTargetFeedId: '1',
          lastMessageAt: Date.now() - 120_000,
          lastMessagePreview: 'Welcome to the team',
          lastMessageSeq: 100,
          joinRequestEndFeedId: 2,
          joinRequestReadFeedId: 0,
        },
      ),
    ]);
    this.conversations.applyThreadMeta(1, {
      lastMessageAt: Date.now() - 60_000,
      lastMessagePreview: 'See you in the playground!',
      lastMessageSeq: 100,
      unreadCount: 2,
    });
    this.rosters.set(
      2,
      ['me', 'alice', 'maya', 'noah', 'olivia'].map((account, i) =>
        this.member(
          this.user(account)!,
          i === 0 ? 'OWNER' : i === 1 ? 'ADMIN' : 'MEMBER',
        ),
      ),
    );
    this.addRequest(
      'FRIEND',
      this.user('maya')!,
      this.self,
      'INCOMING',
      undefined,
      'Hi! Let’s be friends.',
    );
    this.addRequest('FRIEND', this.user('noah')!, this.self, 'INCOMING');
    this.addRequest('FRIEND', this.self, this.user('zoe')!, 'OUTGOING');
    this.addRequest(
      'GROUP_INVITATION',
      this.user('!bookclub')!,
      this.self,
      'INCOMING',
    );
    this.addRequest(
      'GROUP_APPLICATION',
      this.user('ivy')!,
      this.user('!playground')!,
      'INCOMING',
      2,
      'May I join the team?',
    );
    this.addRequest(
      'GROUP_APPLICATION',
      this.user('jack')!,
      this.user('!playground')!,
      'INCOMING',
      2,
    );
  }

  user(account: string, namespaceId = 0): User | undefined {
    return this.users.find(
      (user) => user.account === account && user.namespaceId === namespaceId,
    );
  }

  allocateThreadId(): number {
    return this.nextThreadId++;
  }

  activateFriend(user: User, threadId?: number): number {
    const previous = this.conversations
      .items()
      .find((item) => item.type === 'P2P' && sameIdentity(item.peerUser, user));
    const id = previous?.threadId ?? threadId ?? this.allocateThreadId();
    this.conversations.setRelatedConversations([
      createP2PConversation(id, user, {
        ...(previous?.type === 'P2P' ? previous : {}),
        friendshipActive: true,
        conversationState: 'ACTIVE',
        peerUser: { ...user, isGroup: false },
      }),
    ]);
    return id;
  }

  member(
    user: User,
    role: ResolvedMemberProfile['role'] = 'MEMBER',
  ): ResolvedMemberProfile {
    return {
      identityKey: messageCreatorKey(user),
      account: user.account,
      publisherNamespaceId: 0,
      namespaceId: user.namespaceId,
      role,
      isOwner: role === 'OWNER',
      name: user.name,
      avatar: user.avatar,
      bio: user.bio,
      profileRev: user.profileRev,
      profileResolved: true,
    };
  }

  publishRoster(groupId: number): void {
    this.conversations.applyGroupUpdate(groupId, {
      memberCount: this.rosters.get(groupId)?.length ?? 0,
    });
    this.membersChanged$.next([groupId]);
  }

  addMember(groupId: number, user: User): void {
    const roster = this.rosters.get(groupId) ?? [];
    if (!roster.some((member) => sameIdentity(member, user))) {
      this.rosters.set(groupId, [...roster, this.member(user)]);
      this.publishRoster(groupId);
    }
  }

  addRequest(
    kind: RequestKind,
    author: RequestEndpoint,
    receiver: RequestEndpoint,
    direction: RequestRecord['direction'],
    groupId?: number,
    note = '',
    snapshot?: RequestSnapshot,
  ): RequestRecord {
    const now = new Date().toISOString();
    const base = {
      id: String(this.nextRequestId++),
      kind,
      author: { account: author.account, namespaceId: author.namespaceId },
      receiver: {
        account: receiver.account,
        namespaceId: receiver.namespaceId,
      },
      status: 'REQUESTED' as const,
      note,
      requestedAt: now,
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(Date.now() + WINDOW_MS).toISOString(),
    };
    const record: RequestRecord =
      direction === 'INCOMING'
        ? {
            ...base,
            direction,
            authorProfile: {
              ...base.author,
              profileNamespaceId: 0,
              profileRev:
                this.user(author.account, author.namespaceId)?.profileRev ?? 1,
            },
          }
        : {
            ...base,
            direction,
            snapshot: {
              ...(snapshot ?? {
                displayName:
                  this.user(receiver.account, receiver.namespaceId)?.name ??
                  receiver.account,
                avatar: null,
              }),
            },
          };
    this.requests.push({ record, groupId });
    if (direction === 'INCOMING' && groupId === undefined)
      this.incomingHead.update((head) => ({
        ...head,
        requestEndId: record.id,
      }));
    return record;
  }

  status(record: RequestRecord): RequestRecord['status'] {
    return record.status === 'REQUESTED' &&
      Date.parse(record.expiresAt) <= Date.now()
      ? 'EXPIRED'
      : record.status;
  }

  page(
    records: RequestRecord[],
    params: { before?: string; take?: number },
  ): RequestPage {
    const filtered = records
      .filter(
        (record) =>
          Date.parse(record.createdAt) >= Date.now() - WINDOW_MS &&
          (!params.before || BigInt(record.id) < BigInt(params.before)),
      )
      .sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? -1 : 1));
    const take = Math.max(1, Math.min(50, params.take ?? 20));
    const items = filtered
      .slice(0, take)
      .map((record) =>
        structuredClone({ ...record, status: this.status(record) }),
      );
    const hasMore = filtered.length > take;
    return { items, hasMore, before: hasMore ? items.at(-1)!.id : null };
  }

  settle(record: RequestRecord, status: RequestRecord['status']): void {
    record.status = status;
    record.updatedAt = new Date().toISOString();
  }
}
