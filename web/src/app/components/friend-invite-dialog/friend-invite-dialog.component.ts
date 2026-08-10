import { Component, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { translateBizResult } from '../../services/biz-code';
import { displayUserAccount, displayUserName } from '../../services/model';
import { User, UserService } from '../../services/user.service';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';

@Component({
  selector: 'app-friend-invite-dialog',
  imports: [
    FormsModule,
    MatButtonModule,
    TranslocoPipe,
    UserAvatarComponent,
    FederatedBadgeComponent,
  ],
  templateUrl: './friend-invite-dialog.component.html',
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
  readonly displayUserAccount = displayUserAccount;

  send() {
    if (this.sending()) return;
    this.sending.set(true);
    this.errorText.set('');
    this.userService
      .sendFriendInvite({
        toUserId: this.user().id,
        note: this.note().trim().slice(0, 255),
      })
      .subscribe({
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
