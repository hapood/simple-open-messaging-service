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
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { translateBizResult } from '../../services/biz-code';
import { displayUserName } from '../../services/model';
import { User, UserService } from '../../services/user.service';
import { RouteService } from '../../services/route.service';
import { AvatarRepository } from '../../services/avatar-cache.service';
import { DialogActionFooterComponent } from '../dialog-action-footer/dialog-action-footer.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';

@Component({
  selector: 'app-friend-invite-dialog',
  imports: [
    FormsModule,
    TranslocoPipe,
    UserAvatarComponent,
    DialogActionFooterComponent,
  ],
  templateUrl: './friend-invite-dialog.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './friend-invite-dialog.component.scss',
})
export class FriendInviteDialogComponent {
  private readonly userService = inject(UserService);
  private readonly transloco = inject(TranslocoService);
  private readonly route = inject(RouteService);
  private readonly avatarRepo = inject(AvatarRepository);

  readonly user = input.required<User>();
  /** Direct popup mode; embedded uses continue to delegate completion to their parent. */
  readonly standalone = input(false);
  readonly completed = output<{
    userId: number;
    status: 'OUTGOING_PENDING' | 'FRIEND';
  }>();
  readonly cancelled = output<void>();
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

  cancel(): void {
    if (this.standalone()) this.route.closeDlg();
    else this.cancelled.emit();
  }

  async send() {
    if (this.sending()) return;
    this.sending.set(true);
    this.errorText.set('');
    const user = this.user();
    const avatarIdentity = `${user.isGroup ? 'g' : 'u'}${this.avatarIdentity()}`;
    const avatar = user.avatar
      ? await this.avatarRepo.getCachedDataUrl(avatarIdentity, user.avatar)
      : undefined;
    const request = this.userService.sendFriendInvite({
      account: user.account,
      domain: user.domain || 'local',
      displayName: user.name,
      avatar,
      note: this.note().trim().slice(0, 255),
    });
    request.subscribe({
      next: (res) => {
        if (res.code === 0) {
          const result = {
            userId: this.user().id,
            status:
              res.data?.threadId ||
              res.messageKey === 'friend.msg.alreadyFriends'
                ? 'FRIEND'
                : 'OUTGOING_PENDING',
          } as const;
          if (this.standalone()) this.route.closeDlg(result);
          else this.completed.emit(result);
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
