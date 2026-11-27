import {
  parseSystemMessageContent,
  type SystemEventAddress,
} from '../../../../../../shared/system-message-content';
import { CancellationScope, firstValueFromAbortable } from '../../../lib/async/cancellation-scope';
import { onCbItemPredestory } from '../../../lib/chat-box/cb-item-activity';
import { MemberProfileRepository } from '../../../services/member-profile-store.service';
import { ProfileRepository } from '../../../services/profile-store.service';
import { WebdbService } from '../../../services/webdb.service';
import { ConversationListService } from '../../../services/conversation-list.service';
import { ProfileNamespaceRepository } from '../../../services/profile-namespace-store.service';
import { namespaceDisplayDomain } from '../../../services/profile-namespace-domain';

import {
  unevidencedProfileDemand,
  type ProfileDemand,
} from '../../../../../../shared/profile-demand';
import { UserService } from '../../../services/user.service';
import { displayUserAccount } from '../../../services/model';
import {
  Component,
  computed,
  effect,
  signal,
  inject,
  input,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoService } from '@jsverse/transloco';
import { LanguageService } from '../../../services/language.service';
import type { SystemMessageItem } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';

@Component({
  selector: 'app-msg-system-row',
  standalone: true,
  imports: [DateRowComponent],
  template: `
    @if (showDate()) {
      <app-msg-date-row [ms]="data().createdAtMs" />
    }
    <div class="system-message" role="status">
      @if (labelParts(); as parts) {
        <span class="system-names">{{ parts.names }}</span>
        @if (parts.suffix) {
          <span class="system-suffix">{{ ' ' + parts.suffix }}</span>
        }
      } @else {
        <span class="system-names">{{ label() }}</span>
      }
      @if (!isDeletion() && data().time) {
        <time class="system-suffix">{{ data().time }}</time>
      }
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: `
    :host {
      display: block;
      box-sizing: border-box;
      padding: var(--chat-timeline-gap-item) var(--chat-timeline-inset-inline) 0;
    }
    .system-message {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 4px;
      width: fit-content;
      max-width: min(32rem, 90%);
      height: 24px;
      margin: 0 auto;
      padding: 2px 10px;
      box-sizing: border-box;
      border-radius: 999px;
      color: var(--chat-system-text);
      background: var(--chat-system-bg);
      border: 1px solid var(--chat-system-border);
      font-size: 12px;
      line-height: 18px;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
    }
    .system-names {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .system-suffix {
      flex-shrink: 0;
    }
    time {
      margin-left: 2px;
      opacity: 0.7;
    }
  `,
})
export class SystemRowComponent {
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  readonly data = input.required<SystemMessageItem>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input(false);
  private readonly members = inject(MemberProfileRepository);
  private readonly profiles = inject(ProfileRepository);
  private readonly webdb = inject(WebdbService);
  private readonly conversations = inject(ConversationListService);
  private readonly namespaces = inject(ProfileNamespaceRepository);
  private readonly users = inject(UserService);
  private readonly profileNames = signal<Readonly<Record<string, string>>>({});
  private readonly namespaceDomains = signal<
    Readonly<Record<string, string | null>>
  >({});
  readonly isDeletion = computed(() => {
    const data = this.data();
    return data.type === 'system' && data.deletionType !== undefined;
  });
  private readonly event = computed(() =>
    this.isDeletion() ? null : parseSystemMessageContent(this.data().text),
  );
  private readonly displayIdentity = computed(
    (): SystemEventAddress | undefined => {
      const event = this.event();
      if (!event) return undefined;
      if ('participants' in event) {
        const self = this.users.sessionProfile();
        return event.participants.find(
          (participant) =>
            participant.account !== self?.account ||
            participant.publisherNamespaceId !== self?.namespaceId ||
            participant.profileNamespaceId !== 0,
        );
      }
      if ('members' in event) return event.members[0];
      if ('member' in event) return event.member;
      if (event.type === 'GROUP_CREATED') return event.creator;
      if (event.type === 'GROUP_OWNER_TRANSFERRED') return event.newOwner;
      return undefined;
    },
  );
  private readonly displayIdentities = computed(
    (): readonly SystemEventAddress[] => {
      const event = this.event();
      if (!event) return [];
      if ('members' in event) return event.members;
      const single = this.displayIdentity();
      return single ? [single] : [];
    },
  );

  constructor() {
    const observation = effect((onCleanup) => {
      const data = this.data();
      const identities = this.displayIdentities();
      this.profileNames.set({});
      this.namespaceDomains.set({});
      if (!data.threadId || identities.length === 0) return;
      const seen = new Set<string>();
      for (const identity of identities) {
        const key = this.identityKey(identity);
        if (seen.has(key)) continue;
        seen.add(key);
        this.resolveIdentityDomain(data, identity, key, onCleanup);
        this.resolveProfiledParticipant(data, identity, key, onCleanup);
      }
    });
    onCbItemPredestory(() => observation.destroy());
  }

  private identityKey(identity: SystemEventAddress): string {
    return JSON.stringify([
      identity.publisherNamespaceId,
      identity.profileNamespaceId,
      identity.account,
    ]);
  }

  private setProfileName(key: string, name: string): void {
    this.profileNames.update((prev) =>
      prev[key] === name ? prev : { ...prev, [key]: name },
    );
  }

  private setNamespaceDomain(key: string, domain: string | null): void {
    this.namespaceDomains.update((prev) =>
      prev[key] === domain ? prev : { ...prev, [key]: domain },
    );
  }

  private profilePair(_data: SystemMessageItem, identity: SystemEventAddress) {
    return {
      publisherNamespaceId: identity.publisherNamespaceId,
      profileNamespaceId: identity.profileNamespaceId,
    };
  }

  private resolveIdentityDomain(
    data: SystemMessageItem,
    identity: SystemEventAddress,
    key: string,
    onCleanup: (callback: () => void) => void,
  ): void {
    const subscription = this.namespaces
      .resolve(this.profilePair(data, identity))
      .subscribe({
        next: (binding) =>
          this.setNamespaceDomain(key, namespaceDisplayDomain(binding)),
        error: () => this.setNamespaceDomain(key, null),
      });
    onCleanup(() => subscription.unsubscribe());
  }

  private profileDemand(
    data: SystemMessageItem,
    identity: SystemEventAddress,
    revision: number,
  ): ProfileDemand {
    const item = data.threadId
      ? this.conversations
          .items()
          .find((candidate) => candidate.threadId === data.threadId)
      : undefined;
    if (data.isGroupConversation && item?.type === 'GROUP') {
      return {
        publisherNamespaceId: identity.publisherNamespaceId,
        lookup: 'GROUP_MEMBER_PROFILE',
        target: {
          profileNamespaceId: identity.profileNamespaceId,
          account: identity.account,
          rev: revision,
        },
        groupAccount: item.account,
      };
    }
    return {
      publisherNamespaceId: identity.publisherNamespaceId,
      lookup: 'ACCOUNT_PROFILE',
      target: {
        profileNamespaceId: identity.profileNamespaceId,
        account: identity.account,
        rev: revision,
      },
    };
  }

  /** Resolve an exact profile key from the participant body. */
  private resolveProfiledParticipant(
    data: SystemMessageItem,
    identity: SystemEventAddress,
    participantKey: string,
    onCleanup: (callback: () => void) => void,
  ): void {
    const threadId = data.threadId!;
    let revision =
      data.type === 'system'
        ? (data.localSystemProfileRevs?.[participantKey] ?? identity.profileRev)
        : identity.profileRev;
    const requests = new CancellationScope();
    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
      requests.cancel();
    });
    let request = 0;
    const refresh = () => {
      const current = ++request;
      if (!revision) return;
      void firstValueFromAbortable(
        this.profiles.resolve(
          unevidencedProfileDemand(
            this.profileDemand(data, identity, revision),
          ),
        ),
        requests.signal,
      )
        .then((profile) => {
          if (!cancelled && current === request)
            this.setProfileName(participantKey, profile.name.trim());
        })
        .catch(() => {
          if (!cancelled && current === request)
            this.setProfileName(participantKey, '');
        });
    };
    refresh();
    const subscription = this.members.changed$.subscribe((threadIds) => {
      if (threadIds.includes(threadId)) refresh();
    });
    const event = this.event();
    let evidence: ProfileDemand | undefined;
    if (revision > 0 && revision === identity.profileRev && event) {
      if (
        data.isGroupConversation &&
        [
          'GROUP_CREATED',
          'GROUP_JOINED',
          'GROUP_ADMIN_GRANTED',
          'GROUP_ADMIN_REVOKED',
          'GROUP_OWNER_TRANSFERRED',
        ].includes(event.type)
      )
        evidence = this.profileDemand(data, identity, revision);
      else if (event.type === 'FRIEND_ADDED')
        evidence = this.profileDemand(data, identity, revision);
    }
    const profileSubscription = evidence
      ? this.profiles.resolve(evidence).subscribe({
          next: (profile) => {
            if (cancelled) return;
            if (
              profile.namespaceId !== evidence.target.profileNamespaceId ||
              profile.account !== identity.account
            )
              return;
            revision = profile.rev;
            request++; // Invalidate a slower cache read of the previous revision.
            this.setProfileName(participantKey, profile.name.trim());
            if (profile.rev !== identity.profileRev)
              void this.webdb.correctSystemMessageProfile(
                threadId,
                data.msgId,
                identity.account,
                identity.publisherNamespaceId,
                identity.profileNamespaceId,
                profile.rev,
              );
          },
          error: () => {}, // Preserve the committed local snapshot or address fallback.
        })
      : undefined;
    onCleanup(() => {
      cancelled = true;
      subscription.unsubscribe();
      profileSubscription?.unsubscribe();
    });
  }

  private isCurrentUser(identity: SystemEventAddress): boolean {
    const self = this.users.sessionProfile();
    return (
      !!self &&
      identity.account === self.account &&
      identity.publisherNamespaceId === self.namespaceId &&
      identity.profileNamespaceId === 0
    );
  }

  private resolveDisplayName(
    identity: SystemEventAddress | undefined,
  ): string {
    if (!identity) return '';
    const key = this.identityKey(identity);
    const alias =
      identity.publisherNamespaceId === 0
        ? (this.conversations
            .items()
            .find(
              (item) =>
                item.type === 'P2P' &&
                item.account === identity.account &&
                item.publisherNamespaceId === identity.profileNamespaceId,
            )
            ?.alias?.trim() ?? '')
        : '';
    return (
      alias ||
      this.profileNames()[key] ||
      displayUserAccount({
        account: identity.account,
        namespaceId:
          identity.profileNamespaceId || identity.publisherNamespaceId,
        domain: this.namespaceDomains()[key] ?? null,
      })
    );
  }

  private readonly participantName = computed(() =>
    this.resolveDisplayName(this.displayIdentity()),
  );

  readonly label = computed(() => {
    this.language.lang();
    try {
      const data = this.data();
      const deletionType =
        data.type === 'system' ? data.deletionType : undefined;
      if (deletionType === 'USER_RETRACTION')
        return this.transloco.translate('chat.messageRetracted');
      if (deletionType === 'MODERATION_REMOVAL')
        return this.transloco.translate('chat.messageRemovedByAdmin');
      const body = this.event();
      if (!body) return this.fallback('invalid system message content');
      if (body.type === 'CALL_ENDED') {
        const call = body;
        const media = this.transloco.translate(
          call.mediaType === 'VIDEO' ? 'call.videoCall' : 'call.audioCall',
        );
        const direction = this.transloco.translate(
          this.isCurrentUser(call.caller)
            ? 'call.record.outgoing'
            : 'call.record.incoming',
        );
        const result = this.transloco.translate(
          call.outcome === 'completed'
            ? 'call.ended'
            : `call.record.${call.outcome}`,
        );
        const duration =
          call.connectedAt === undefined
            ? ''
            : ` · ${Math.floor((call.endedAt - call.connectedAt) / 60000)}:${String(Math.floor((call.endedAt - call.connectedAt) / 1000) % 60).padStart(2, '0')}`;
        const waitMs = (call.connectedAt ?? call.endedAt) - call.initiatedAt;
        const waiting = this.transloco.translate('call.record.waiting', {
          duration: `${Math.floor(waitMs / 60000)}:${String(Math.floor(waitMs / 1000) % 60).padStart(2, '0')}`,
        });
        const started = new Date(call.initiatedAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        });
        return `${direction} · ${media} · ${result} · ${started} · ${waiting}${duration}`;
      }
      const name = this.participantName();
      const translate = (key: string) =>
        this.transloco.translate(`chat.systemMessage.${key}`, { name });
      switch (body.type) {
        case 'FRIEND_ADDED':
          return translate('friendAdded');
        case 'FRIEND_REMOVED':
          if (
            body.initiator.account === '$system' &&
            body.initiator.profileNamespaceId === 0
          )
            return translate('friendRemoved');
          if (this.isCurrentUser(body.initiator))
            return name
              ? translate('friendRemovedSelf')
              : translate('friendRemoved');
          return translate('friendRemovedOther');
        case 'GROUP_CREATED':
          return translate('groupCreated');
        case 'GROUP_JOINED': {
          const names = this.formatBatchMemberNames(body.members);
          return this.formatBatchAction(
            names,
            body.totalCount,
            body.members.length,
            'groupJoined',
          );
        }
        case 'GROUP_LEFT': {
          if (
            body.totalCount === 1 &&
            body.members.some((m) => this.isCurrentUser(m))
          ) {
            return translate('groupLeftSelf');
          }
          const names = this.formatBatchMemberNames(body.members);
          return this.formatBatchAction(
            names,
            body.totalCount,
            body.members.length,
            'groupLeft',
          );
        }
        case 'GROUP_DISSOLVED':
          return translate('groupDissolved');
        case 'GROUP_ADMIN_GRANTED':
          return translate('groupAdminGranted');
        case 'GROUP_ADMIN_REVOKED':
          return translate('groupAdminRevoked');
        case 'GROUP_OWNER_TRANSFERRED':
          return translate('groupOwnerTransferred');
      }
      return this.fallback('unknown system message type');
    } catch (error) {
      return this.fallback('failed to render system message', error);
    }
  });

  readonly labelParts = computed(
    (): { names: string; suffix: string } | null => {
      const body = this.event();
      if (!body) return null;
      if (body.type !== 'GROUP_JOINED' && body.type !== 'GROUP_LEFT')
        return null;
      if (
        body.type === 'GROUP_LEFT' &&
        body.totalCount === 1 &&
        body.members.some((m) => this.isCurrentUser(m))
      ) {
        return null;
      }
      this.language.lang();
      const names = this.formatBatchMemberNames(body.members);
      const key = body.type === 'GROUP_JOINED' ? 'groupJoined' : 'groupLeft';
      const full = this.formatBatchAction(
        '',
        body.totalCount,
        body.members.length,
        key,
      ).trim();
      return { names, suffix: full };
    },
  );

  private formatBatchMemberNames(
    members: readonly SystemEventAddress[],
  ): string {
    return members.map((member) => this.resolveDisplayName(member)).join('、');
  }

  private formatBatchAction(
    names: string,
    totalCount: number,
    shownCount: number,
    key: 'groupJoined' | 'groupLeft',
  ): string {
    const base = this.transloco.translate(`chat.systemMessage.${key}`, {
      name: names,
    });
    if (totalCount <= shownCount) return base;
    const isZh = this.language.lang().startsWith('zh');
    const extra = isZh
      ? `等 ${totalCount} 人`
      : ` and ${totalCount - shownCount} others`;
    return names
      ? `${names}${extra} ${base.replace(names, '').trim()}`
      : `${extra.trim()} ${base.trim()}`;
  }

  private fallback(reason: string, error?: unknown): string {
    console.error(`[system-message] ${reason}`, error ?? this.data().text);
    try {
      return this.transloco.translate('chat.systemMessage.updated');
    } catch (translationError) {
      console.error(
        '[system-message] failed to translate fallback',
        translationError,
      );
      return 'Conversation updated';
    }
  }
}
