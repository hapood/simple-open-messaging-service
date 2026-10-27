import { Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type {
  RequestEndpoint,
  RequestKind,
  RequestRecord,
  RequestPage,
} from '../../../shared/relationship-request';
import type { ProfileDemand } from '../../../shared/profile-demand';
import type { RequestSnapshot } from '../../../shared/request-snapshot';
import {
  createGroupConversation,
  createP2PConversation,
  messageCreatorKey,
  type User,
} from '../app/services/model';
import type { ResolvedMemberProfile } from '../app/services/member-profile-store.service';
import { PlaygroundConversationList } from './playground-conversation-list.mock';
import { playgroundAvatars } from './playground-avatars';

const WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const sameIdentity = (a: RequestEndpoint, b: RequestEndpoint) =>
  a.account === b.account && a.namespaceId === b.namespaceId;

const seededBios: Record<string, string> = {
  alice: 'Curious mind, coffee lover, and weekend explorer.',
  maya: 'Designing little things that make everyday life better.',
  noah: 'Music, good conversations, and a new trail to explore.',
  liam: 'Building things and sharing what I learn along the way.',
  ivy: 'Here to learn, collaborate, and meet the community.',
  '!playground': 'A place to try things out together.',
  '!bookclub':
    'A cozy community for book lovers to share reads, reviews, and thoughtful discussions.',
};

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
          : playgroundAvatars[account]
            ? account[0].toUpperCase() + account.slice(1)
            : account,
    avatar: playgroundAvatars[account] ?? '',
    bio: seededBios[account] ?? '',
    namespaceId: account === 'liam' ? 1 : 0,
    profileRev: playgroundAvatars[account] ? 1 : 0,
    isDeleted: false,
    isGroup: account.startsWith('!'),
  }));
  private readonly profiles = new Map(
    this.users
      .filter((user) => user.profileRev > 0)
      .map((user) => [this.profileKey(user), { ...user }]),
  );
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
    this.activateFriend(this.user('liam', 1)!, 6);
    this.conversations.setRelatedConversations([
      createGroupConversation({
        threadId: 2,
        account: '!playground',
        publisherNamespaceId: 0,
        profileRev: 1,
        profile: {
          name: 'Playground Team',
          bio: 'Alice · Maya · Noah · Olivia · You',
          avatarDigest: null,
        },
        meta: {
          memberCount: 5,
          groupMetaFeedId: '1',
          announcementFeedId: '1',
          announcementText:
            'Welcome to Playground Team! This group is for exploring group chat, announcements, and member management. All modifications are stored only in the current session; refresh the page to reset.',
        },
        role: 'OWNER',
        groupMetaFeedEndId: '1',
        announcementReadFeedId: 0,
        lastMessageAt: Date.now() - 120_000,
        lastMessagePreview: 'Welcome to the team',
        messageEndSeq: 100,
        joinRequestEndFeedId: 2,
        joinRequestReadFeedId: 0,
      }),
    ]);
    this.conversations.applyThreadMeta(1, {
      lastMessageAt: Date.now() - 60_000,
      lastMessagePreview: 'See you in the playground!',
      messageEndSeq: 100,
      muted: true,
      pinned: true,
    });
    this.conversations.applyThreadMeta(2, {
      unreadCount: 3,
      mentionUnread: ['me'],
    });
    this.conversations.applyThreadMeta(6, {
      blocked: true,
      lastMessageAt: Date.now() - 180_000,
      lastMessagePreview: 'Hey, are you free to chat?',
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

  private profileKey(
    user: Pick<User, 'namespaceId' | 'account' | 'profileRev'>,
  ): string {
    return JSON.stringify([user.namespaceId, user.account, user.profileRev]);
  }

  profile(
    account: string,
    namespaceId: number,
    profileRev: number,
  ): User | undefined {
    if (profileRev === 0) return undefined;
    const key = this.profileKey({ account, namespaceId, profileRev });
    const snapshot = this.profiles.get(key);
    if (snapshot) return { ...snapshot };
    const current = this.user(account, namespaceId);
    if (current?.profileRev !== profileRev) return undefined;
    this.profiles.set(key, { ...current });
    return { ...current };
  }

  /** Map an immutable profile demand onto the seeded fixtures.
   * ACCOUNT_PROFILE: an account's own profile lives at namespace 0 inside
   * its home (publisher) namespace's store, mirroring homeProfileDemand.
   * GROUP_MEMBER_PROFILE: the group's publisher namespace authorizes the
   * lookup; the member's home namespace is the subject profile namespace
   * inside that publisher's store. */
  profileOfDemand(demand: ProfileDemand): User | undefined {
    if (demand.lookup === 'ACCOUNT_PROFILE') {
      if (demand.target.profileNamespaceId !== 0) return undefined;
      return this.profile(
        demand.target.account,
        demand.publisherNamespaceId,
        demand.target.rev,
      );
    }
    const group = this.user(demand.groupAccount, demand.publisherNamespaceId);
    if (!group?.isGroup) return undefined;
    return this.profile(
      demand.target.account,
      demand.target.profileNamespaceId,
      demand.target.rev,
    );
  }

  publishProfile(
    user: User,
    patch: Pick<User, 'name' | 'bio' | 'avatar'>,
  ): void {
    if (user.profileRev > 0)
      this.profiles.set(this.profileKey(user), { ...user });
    Object.assign(user, patch, { profileRev: user.profileRev + 1 });
    this.profiles.set(this.profileKey(user), { ...user });
  }

  publishSelfProfile(patch: Pick<User, 'name' | 'bio' | 'avatar'>): void {
    this.publishProfile(this.self, patch);
    const changed: number[] = [];
    for (const [threadId, roster] of this.rosters) {
      if (!roster.some((member) => sameIdentity(member, this.self))) continue;
      this.rosters.set(
        threadId,
        roster.map((member) =>
          sameIdentity(member, this.self)
            ? this.member(this.self, member.role)
            : member,
        ),
      );
      changed.push(threadId);
    }
    if (changed.length) this.membersChanged$.next(changed);
  }

  allocateThreadId(): number {
    return this.nextThreadId++;
  }

  activateFriend(user: User, threadId?: number): number {
    const previous = this.conversations
      .items()
      .find(
        (item) =>
          item.type === 'P2P' &&
          sameIdentity(
            { account: item.account, namespaceId: item.publisherNamespaceId },
            user,
          ),
      );
    const id = previous?.threadId ?? threadId ?? this.allocateThreadId();
    this.conversations.setRelatedConversations([
      createP2PConversation({
        ...previous,
        threadId: id,
        account: user.account,
        publisherNamespaceId: user.namespaceId,
        profileRev: user.profileRev,
        conversationState: 'ACTIVE',
        profile: { name: user.name, bio: user.bio ?? '', avatarDigest: null },
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
      bio: user.bio,
      profileRev: user.profileRev,
      profileResolved: true,
    };
  }

  publishRoster(groupId: number): void {
    this.conversations.applyGroupUpdate(groupId, {
      meta: { memberCount: this.rosters.get(groupId)?.length ?? 0 },
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
                this.user(author.account, author.namespaceId)?.profileRev ?? 0,
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
