import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouteService, PopupType } from '../../services/route.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import type { User } from '../../services/model';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';

export interface ContactIdentityDialogData {
  userId?: number;
  account: string;
  name: string;
  avatar?: string;
  domain: string;
  friendThreadId?: number;
  groupThreadId?: number;
}

@Component({
  selector: 'app-contact-identity-dialog',
  standalone: true,
  imports: [UserAvatarComponent, TranslocoPipe],
  templateUrl: './contact-identity-dialog.component.html',
  styleUrl: './contact-identity-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContactIdentityDialogComponent {
  private readonly route = inject(RouteService);
  private readonly nav = inject(NavStateMachineService);
  readonly identity = input.required<ContactIdentityDialogData>();
  readonly isGroup = computed(() => this.identity().account.startsWith('!'));
  readonly avatarType = computed(() =>
    this.isGroup() ? UserAvatarType.GROUP : UserAvatarType.OTHER,
  );
  readonly federatedDomain = computed(() => {
    const domain = this.identity().domain;
    return domain && domain !== 'local' ? domain : null;
  });
  readonly actionKey = computed(() => {
    const identity = this.identity();
    if (this.isGroup())
      return identity.groupThreadId === undefined
        ? null
        : 'contactCard.enterGroup';
    return identity.friendThreadId === undefined
      ? 'friend.addAction'
      : 'profile.openChat';
  });

  act(): void {
    const identity = this.identity();
    const threadId = this.isGroup()
      ? identity.groupThreadId
      : identity.friendThreadId;
    if (threadId !== undefined) {
      this.route.closeDlg();
      this.nav.openChat(threadId);
      return;
    }
    if (this.isGroup()) return;
    this.route.closeDlg();
    this.route.popupDlg(PopupType.FRIEND_REQUESTS, {
      initialUser: {
        id: identity.domain === 'local' ? (identity.userId ?? 0) : 0,
        account: identity.account,
        name: identity.name,
        avatar: identity.avatar ?? '',
        domain: identity.domain === 'local' ? 'local' : identity.domain,
        isForeigner: identity.domain !== 'local',
      } as User,
    });
  }
}
