import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';
import { RouteService, PopupType } from '../../../services/route.service';
import { ConversationListService } from '../../../services/conversation-list.service';
import { UserService } from '../../../services/user.service';
import { NavStateMachineService } from '../../../services/nav-state.service';

interface ContactCard {
  account: string;
  domain: string;
  displayName: string;
  bio: string;
  avatar?: string;
}

@Component({
  selector: 'app-msg-contact-card-row',
  standalone: true,
  imports: [UserAvatarComponent, DateRowComponent, TranslocoPipe],
  templateUrl: './contact-card-row.component.html',
  styleUrl: './contact-card-row.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContactCardRowComponent {
  private readonly route = inject(RouteService);
  private readonly conversations = inject(ConversationListService);
  private readonly userService = inject(UserService);
  private readonly nav = inject(NavStateMachineService);
  readonly UserAvatarType = UserAvatarType;
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input(false);
  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(
    () =>
      this.isShowHead() &&
      this.data().isGroupConversation === true &&
      !this.data().isSelf,
  );
  readonly card = computed<ContactCard | null>(() => {
    try {
      const value = JSON.parse(this.data().text) as Partial<ContactCard>;
      return typeof value.account === 'string' &&
        typeof value.domain === 'string' &&
        typeof value.displayName === 'string' &&
        typeof value.bio === 'string'
        ? (value as ContactCard)
        : null;
    } catch {
      return null;
    }
  });
  readonly isGroupCard = computed(
    () => this.card()?.account.startsWith('!') ?? false,
  );
  readonly cardAvatarType = computed(() =>
    this.isGroupCard() ? UserAvatarType.GROUP : UserAvatarType.OTHER,
  );
  readonly cardFederatedDomain = computed(() => {
    const domain = this.card()?.domain;
    return domain && domain !== 'local' ? domain : null;
  });
  openCard(): void {
    const card = this.card();
    if (!card) return;
    const conversation = this.conversations
      .items()
      .find((item) =>
        card.account.startsWith('!')
          ? item.type === 'GROUP' &&
            item.group.account === card.account &&
            item.group.domain === card.domain
          : item.type === 'P2P' &&
            item.peerUser.account === card.account &&
            item.peerUser.domain === card.domain &&
            item.friendshipActive !== false,
      );
    this.route.popupDlg(
      PopupType.CONTACT_IDENTITY,
      {
        identity: {
          account: card.account,
          name: card.displayName,
          bio: card.bio,
          avatar: card.avatar,
          domain: card.domain,
          ...(conversation?.type === 'GROUP'
            ? { namespaceId: conversation.group.namespaceId }
            : conversation?.type === 'P2P'
              ? { namespaceId: conversation.peerUser.namespaceId }
              : card.domain === 'local'
                ? { namespaceId: 0 }
                : {}),
          relationship:
            card.account === this.userService.sessionProfile()?.account &&
            card.domain ===
              (this.userService.sessionProfile()?.domain || 'local')
              ? 'SELF'
              : conversation?.type === 'P2P'
                ? 'FRIEND'
                : 'NONE',
          ...(conversation?.type === 'GROUP'
            ? {
                groupThreadId: conversation.threadId,
                userId: conversation.group.id,
              }
            : conversation?.type === 'P2P'
              ? {
                  friendThreadId: conversation.threadId,
                }
              : {}),
        },
      },
      undefined,
      { scopeThreadId: this.nav.chatThreadId() },
    );
  }
}
