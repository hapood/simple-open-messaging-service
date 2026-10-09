import {
  parseSystemMessageContent,
  type SystemEventAddress,
} from '../../../../../../shared/system-message-content';
import { firstValueFrom } from 'rxjs';
import { MemberProfileRepository } from '../../../services/member-profile-store.service';
import { ProfileRepository } from '../../../services/profile-store.service';
import { WebdbService } from '../../../services/webdb.service';
import { ConversationListService } from '../../../services/conversation-list.service';

import {
  unevidencedProfileDemand,
  type ProfileDemand,
} from '../../../../../../shared/profile-demand';
import { UserService } from '../../../services/user.service';
import { LocalDomainService } from '../../../services/local-domain.service';
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
import type { ChatMsgData } from '../chat-item';
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
      {{ label() }} <time>{{ data().time }}</time>
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
      width: fit-content;
      max-width: min(32rem, 90%);
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
    }
    time {
      margin-left: 6px;
      opacity: 0.7;
    }
  `,
})
export class SystemRowComponent {
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input(false);
  private readonly members = inject(MemberProfileRepository);
  private readonly profiles = inject(ProfileRepository);
  private readonly webdb = inject(WebdbService);
  private readonly conversations = inject(ConversationListService);
  private readonly users = inject(UserService);
  private readonly localDomain = inject(LocalDomainService);
  private readonly profileName = signal('');
  private readonly event = computed(() =>
    parseSystemMessageContent(this.data().text),
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
            participant.domain !== (this.localDomain.domain() ?? 'local'),
        );
      }
      if ('member' in event) return event.member;
      if (event.type === 'GROUP_CREATED') return event.creator;
      if (event.type === 'GROUP_OWNER_TRANSFERRED') return event.newOwner;
      return undefined;
    },
  );

  constructor() {
    effect((onCleanup) => {
      const data = this.data();
      const identity = this.displayIdentity();
      this.profileName.set('');
      if (!identity || !data.threadId) return;
      this.resolveProfiledParticipant(data, identity, onCleanup);
    });
  }

  /** Resolve an exact profile key without ever deriving a member namespace from the group. */
  private resolveProfiledParticipant(
    data: ChatMsgData,
    identity: SystemEventAddress,
    onCleanup: (callback: () => void) => void,
  ): void {
    const threadId = data.threadId!;
    const participantKey = JSON.stringify([
      identity.profileNamespaceId,
      identity.account,
    ]);
    let revision =
      data.type === 'system'
        ? (data.localSystemProfileRevs?.[participantKey] ?? identity.profileRev)
        : identity.profileRev;
    let cancelled = false;
    let request = 0;
    const refresh = () => {
      const current = ++request;
      if (!revision) return;
      void firstValueFrom(
        this.profiles.resolve(
          unevidencedProfileDemand({
            publisherNamespaceId: identity.profileNamespaceId,
            lookup: 'ACCOUNT_PROFILE',
            target: {
              profileNamespaceId: identity.profileNamespaceId,
              account: identity.account,
              rev: revision,
            },
          }),
        ),
      )
        .then((profile) => {
          if (!cancelled && current === request)
            this.profileName.set(profile.name.trim());
        })
        .catch(() => {
          if (!cancelled && current === request) this.profileName.set('');
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
        evidence = {
          publisherNamespaceId: identity.profileNamespaceId,
          lookup: 'GROUP_MEMBER_PROFILE',
          target: {
            profileNamespaceId: identity.profileNamespaceId,
            account: identity.account,
            rev: revision,
          },
          groupAccount: (() => {
            const item = this.conversations
              .items()
              .find((candidate) => candidate.threadId === threadId);
            return item?.type === 'GROUP' ? item.group.account : '';
          })(),
        };
      else if (event.type === 'FRIEND_ADDED')
        evidence = {
          publisherNamespaceId: identity.profileNamespaceId,
          lookup: 'ACCOUNT_PROFILE',
          target: {
            profileNamespaceId: identity.profileNamespaceId,
            account: identity.account,
            rev: revision,
          },
        };
    }
    const profileSubscription = evidence
      ? this.profiles.resolve(evidence).subscribe({
          next: (profile) => {
            if (cancelled) return;
            if (
              profile.namespaceId !== identity.profileNamespaceId ||
              profile.account !== identity.account
            )
              return;
            revision = profile.rev;
            request++; // Invalidate a slower cache read of the previous revision.
            this.profileName.set(profile.name.trim());
            if (profile.rev !== identity.profileRev)
              void this.webdb.correctSystemMessageProfile(
                threadId,
                data.msgId,
                identity.account,
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
      identity.profileNamespaceId === self.namespaceId
    );
  }

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
      const identity = this.displayIdentity();
      const alias = identity
        ? (this.conversations
            .items()
            .find(
              (item) =>
                item.type === 'P2P' &&
                item.peerUser.account === identity.account &&
                item.peerUser.namespaceId === identity.profileNamespaceId,
            )
            ?.alias?.trim() ?? '')
        : '';
      const name =
        alias || this.profileName() || displayUserAccount(identity ?? {});
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
        case 'GROUP_JOINED':
          return translate('groupJoined');
        case 'GROUP_LEFT':
          return translate(
            this.isCurrentUser(body.member) ? 'groupLeftSelf' : 'groupLeft',
          );
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
