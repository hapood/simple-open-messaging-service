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
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { translateBizResult } from '../../services/biz-code';
import { displayUserName } from '../../services/model';
import { User, UserService } from '../../services/user.service';
import { RouteService } from '../../services/route.service';
import { avatarBlobDataUrl } from '../../services/profile-avatar-bytes';
import { assetUrl } from '../../services/runtime';
import { GroupService } from '../../services/group.service';
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
  private readonly http = inject(HttpClient);
  private readonly groupService = inject(GroupService);

  readonly user = input.required<User>();
  /** Direct popup mode; embedded uses continue to delegate completion to their parent. */
  readonly standalone = input(false);
  readonly completed = output<{
    account: string;
    domain: string;
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
    return JSON.stringify([user.domain ?? 'local', user.account]);
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
    let avatar: string | undefined;
    if (user.avatar) {
      try {
        avatar = user.avatar.startsWith('data:')
          ? user.avatar
          : await avatarBlobDataUrl(
              await firstValueFrom(
                this.http.get(assetUrl(user.avatar), { responseType: 'blob' }),
              ),
            );
      } catch {
        avatar = undefined;
      }
    }
    const note = this.note().trim().slice(0, 255);
    const request = this.userService.requestRelationship({
      account: user.account,
      domain: user.domain || 'local',
      ...((user.domain || 'local') === 'local'
        ? {}
        : {
            displayName: user.name,
            avatar,
            ...(user.namespaceId > 0 ? { namespaceId: user.namespaceId } : {}),
          }),
      note,
    });
    request.subscribe({
      next: (res) => {
        if (res.code === 0) {
          const threadId =
            res.data && 'threadId' in res.data ? res.data.threadId : undefined;
          const result = {
            account: this.user().account,
            domain: this.user().domain || 'local',
            status:
              threadId || res.messageKey === 'friend.msg.alreadyFriends'
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
