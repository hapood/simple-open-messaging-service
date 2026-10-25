import {
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import {
  defer,
  filter,
  finalize,
  from,
  fromEvent,
  map,
  Observable,
  of,
  switchMap,
  take,
  takeUntil,
  throwError,
} from 'rxjs';
import type { RequestSnapshot } from '../../../../../shared/request-snapshot';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { translateBizResult } from '../../services/biz-code';
import { displayUserName, type InviteSubject } from '../../services/model';
import { avatarProfileDemand } from '../../services/avatar-profile-ref';
import { ProfileRepository } from '../../services/profile-store.service';
import { UserService } from '../../services/user.service';
import { RouteService } from '../../services/route.service';
import { avatarBlobDataUrl } from '../../services/profile-avatar-bytes';
import { assetUrl } from '../../services/runtime';
import { SessionLifecycleService } from '../../services/session-lifecycle.service';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { DialogActionFooterComponent } from '../dialog-action-footer/dialog-action-footer.component';
import { SnapshotAvatarComponent } from '../user-avatar/snapshot-avatar.component';
import { DemandAvatarComponent } from '../user-avatar/demand-avatar.component';
import { UserAvatarType } from '../user-avatar/model';

@Component({
  selector: 'app-friend-invite-dialog',
  imports: [
    FormsModule,
    TranslocoPipe,
    SnapshotAvatarComponent,
    DemandAvatarComponent,
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
  private readonly profiles = inject(ProfileRepository);
  private readonly sessionLifecycle = inject(SessionLifecycleService);
  private readonly destroyRef = inject(DestroyRef);

  readonly user = input.required<InviteSubject>();
  private readonly userChanges$ = toObservable(this.user);
  readonly profile = computed(() => {
    const user = this.user();
    return 'profile' in user ? user.profile : undefined;
  });
  readonly snapshotAvatar = computed(() => {
    const user = this.user();
    return 'avatar' in user ? user.avatar : undefined;
  });
  /** Direct popup mode; embedded uses continue to delegate completion to their parent. */
  readonly standalone = input(false);
  readonly completed = output<{
    account: string;
    namespaceId: number;
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
    return JSON.stringify([user.namespaceId, user.account]);
  });

  cancel(): void {
    if (this.standalone()) this.route.closeDlg();
    else this.cancelled.emit();
  }

  send(): void {
    if (this.sending()) return;
    const user = this.user();
    const session = this.sessionLifecycle.capture();
    const note = this.note().trim().slice(0, 255);
    this.sending.set(true);
    this.errorText.set('');
    defer(() => this.requestSnapshot(user))
      .pipe(
        take(1),
        switchMap((snapshot) =>
          this.userService.requestRelationship({
            account: user.account,
            namespaceId: user.namespaceId,
            snapshot,
            note,
          }),
        ),
        takeUntil(fromEvent(session.signal, 'abort')),
        takeUntil(this.userChanges$.pipe(filter(() => this.user() !== user))),
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.sending.set(false)),
      )
      .subscribe({
        next: (res) => {
          if (res.code === 0) {
            const threadId =
              res.data && 'threadId' in res.data
                ? res.data.threadId
                : undefined;
            const result = {
              account: user.account,
              namespaceId: user.namespaceId,
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
        },
        error: () => {
          this.errorText.set(
            this.transloco.translate('friend.error.unknownError'),
          );
        },
      });
  }

  /** Freeze send-time presentation; this is not the dialog's rendering source. */
  private requestSnapshot(user: InviteSubject): Observable<RequestSnapshot> {
    if ('profile' in user) {
      const demand = avatarProfileDemand(user.profile);
      if (!demand)
        return throwError(
          () => new Error('invitation requires a published profile'),
        );
      return this.profiles.resolve(demand).pipe(
        take(1),
        switchMap((profile) =>
          profile.avatarBlob
            ? from(avatarBlobDataUrl(profile.avatarBlob)).pipe(
                map((avatar) => ({ displayName: profile.name, avatar })),
              )
            : of({ displayName: profile.name, avatar: null }),
        ),
      );
    }

    // Lookup endpoints supply display data directly, without demand authorization.
    const avatar: Observable<string | null> = !user.avatar
      ? of(null)
      : user.avatar.startsWith('data:')
        ? of(user.avatar)
        : this.http
            .get(assetUrl(user.avatar), { responseType: 'blob' })
            .pipe(switchMap((blob) => from(avatarBlobDataUrl(blob))));
    return avatar.pipe(
      map((value) => ({ displayName: user.name, avatar: value })),
    );
  }
}
