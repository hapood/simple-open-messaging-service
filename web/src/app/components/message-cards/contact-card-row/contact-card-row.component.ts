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
        value.domain.trim().length > 0 &&
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
  readonly cardDomainSource = computed(() => {
    const card = this.card();
    return card
      ? ({ type: 'snapshot', domain: card.domain } as const)
      : undefined;
  });
  openCard(): void {
    const card = this.card();
    if (!card) return;
    this.route.popupDlg(
      PopupType.FRIEND_REQUESTS,
      {
        initialTab: 'add',
        initialAddress: { account: card.account, domain: card.domain },
      },
      undefined,
      { scopeThreadId: this.nav.chatThreadId() },
    );
  }
}
