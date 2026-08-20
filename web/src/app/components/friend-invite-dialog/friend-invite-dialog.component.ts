import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { translateBizResult } from '../../services/biz-code';
import { displayUserName } from '../../services/model';
import { User, UserService } from '../../services/user.service';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';

@Component({
  selector: 'app-friend-invite-dialog',
  imports: [FormsModule, MatButtonModule, TranslocoPipe, UserAvatarComponent],
  templateUrl: './friend-invite-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './friend-invite-dialog.component.scss',
})
export class FriendInviteDialogComponent {
  private readonly userService = inject(UserService);
  private readonly transloco = inject(TranslocoService);

  readonly user = input.required<User>();
  readonly completed = output<{
    userId: number;
    status: 'OUTGOING_PENDING' | 'FRIEND';
  }>();
  readonly note = signal('');
  readonly sending = signal(false);
  readonly errorText = signal('');
  readonly UserAvatarType = UserAvatarType;
  readonly displayUserName = displayUserName;
  readonly avatarIdentity = computed(() => {
    const user = this.user();
    return user.id > 0
      ? user.id
      : `${user.domain ?? 'local'}\u0000${user.account}`;
  });

  send() {
    if (this.sending()) return;
    this.sending.set(true);
    this.errorText.set('');
    const user = this.user();
    const request =
      user.id === 0 && user.isForeigner && user.domain
        ? this.userService.sendFederatedFriendInvite({
            account: user.account,
            domain: user.domain,
            displayName: user.name,
            avatar: user.avatar,
            note: this.note().trim().slice(0, 255),
          })
        : this.userService.sendFriendInvite({
            toUserId: user.id,
            note: this.note().trim().slice(0, 255),
          });
    request.subscribe({
      next: (res) => {
        if (res.code === 0) {
          this.completed.emit({
            userId: this.user().id,
            status:
              res.data?.threadId ||
              res.messageKey === 'friend.msg.alreadyFriends'
                ? 'FRIEND'
                : 'OUTGOING_PENDING',
          });
          return;
        }
        this.errorText.set(translateBizResult(res, this.transloco));
        this.sending.set(false);
      },
      error: () => {
        this.errorText.set(
          this.transloco.translate('friend.error.unknownError'),
        );
        this.sending.set(false);
      },
    });
  }
}
