import {
  Component,
  signal,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { RouteService, PopupType } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { GroupService } from '../../services/group.service';
import { ConversationListService } from '../../services/conversation-list.service';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import { apiPrefix } from '../../services/constants';
import { finalize } from 'rxjs';
import { translateBizResult } from '../../services/biz-code';
import { ToastService } from '../../services/toast.service';

/**
 * New-group dialog for entering the group's name, avatar, and optional description.
 * Members can be invited after creation from the group-info panel.
 */
@Component({
  selector: 'app-new-group',
  imports: [
    IconComponent,
    UserAvatarComponent,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    FormsModule,
    FitDialogDirective,
    TranslocoPipe,
  ],
  templateUrl: './new-group.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './new-group.component.scss',
})
export class NewGroupComponent {
  readonly fitOpts = { settleMs: 600, minHeight: 360 } as const;
  readonly AppIconType = AppIconType;
  readonly UserAvatarType = UserAvatarType;
  readonly NAME_MAX = 31;
  /** Max length of the optional group description. */
  readonly DESC_MAX = 240;

  /** Staged group avatar URL (uploaded before creation), if any. */
  readonly pendingAvatar = signal<string | undefined>(undefined);
  /** True while an avatar crop is uploading. */
  readonly avatarUploading = signal(false);
  /** True from the first create attempt until its response settles; guards clicks and Enter. */
  readonly submitting = signal(false);

  /** Group name — user-entered (never prefilled); required, must be non-empty. */
  readonly name = signal('');
  /** Optional group description. */
  readonly description = signal('');

  private readonly routeService = inject(RouteService);
  private readonly groupService = inject(GroupService);
  private readonly http = inject(HttpClient);
  private readonly transloco = inject(TranslocoService);
  private readonly convList = inject(ConversationListService);
  private readonly toast = inject(ToastService);

  /** User typed into the name field. */
  onNameInput(v: string) {
    this.name.set(v);
  }

  /** User typed into the description field. */
  onDescInput(v: string) {
    this.description.set(v);
  }

  /** Close the dialog unless a create request is in flight. */
  onBack() {
    if (this.submitting()) return;
    this.routeService.closeDlg();
  }

  /** Pick a group photo via the cropper, upload it, stage the returned URL (not yet persisted). */
  pickAvatar(fileInput: HTMLInputElement) {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    this.routeService.popupDlg(PopupType.AVATAR_EDITOR, { file }, (res) => {
      if (res?.file) this.uploadAvatar(res.file);
    });
  }

  private uploadAvatar(file: File) {
    this.avatarUploading.set(true);
    // /upload/avatar runs the server-side sharp cover-crop, so it needs only the file (no w/h —
    // avatars are square). Returns { avatar } (a /uploads/avatars/ url) staged until group creation.
    const fd = new FormData();
    fd.append('file', file);
    this.http
      .post<{ code: number; data?: { avatar: string } }>(
        `${apiPrefix()}/upload/avatar`,
        fd,
      )
      .subscribe({
        next: (res) => {
          if (res?.code === 0 && res.data?.avatar)
            this.pendingAvatar.set(res.data.avatar);
        },
        error: () =>
          this.toast.warn(this.transloco.translate('errors.networkError')),
      })
      .add(() => this.avatarUploading.set(false));
  }

  /** Create the group, then close the dialog. */
  confirm() {
    if (this.submitting() || this.avatarUploading()) return;
    const name = this.name().trim();
    if (!name) return;
    this.submitting.set(true);
    const avatar = this.pendingAvatar();
    this.groupService
      .createGroup({
        name,
        avatar,
        description: this.description().trim() || undefined,
      })
      .pipe(finalize(() => this.submitting.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code === 0 && res.data) {
            // Promote the new group to the top of the list (the caller's refresh→load converges on it)
            // so it animates in via the FLIP enter rather than sinking to the bottom (empty lastMessageAt).
            this.convList.markTopOnNextUpdate(res.data.threadId);
            this.routeService.closeDlg({ groupId: res.data.groupId });
          } else {
            this.toast.warn(translateBizResult(res, this.transloco));
          }
        },
        error: () =>
          this.toast.warn(this.transloco.translate('errors.networkError')),
      });
  }
}
