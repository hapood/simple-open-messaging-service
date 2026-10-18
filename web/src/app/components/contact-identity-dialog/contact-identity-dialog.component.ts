import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  signal,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouteService, PopupType } from '../../services/route.service';
import { NavStateMachineService } from '../../services/nav-state.service';
import type { UserRef } from '../../services/model';
import { UserService } from '../../services/user.service';
import { LocalDomainService } from '../../services/local-domain.service';
import { SnapshotAvatarComponent } from '../user-avatar/snapshot-avatar.component';
import { UserAvatarType } from '../user-avatar/model';
import { DialogActionFooterComponent } from '../dialog-action-footer/dialog-action-footer.component';

export interface ContactIdentityDialogData {
  userId?: number;
  account: string;
  name: string;
  avatar?: string;
  bio: string;
  domain: string;
  /** Resolved identity coordinate. Fixed address snapshots enter the address-query flow instead. */
  namespaceId: number;
  friendThreadId?: number;
  groupThreadId?: number;
  relationship?: RelationshipState;
}

export type RelationshipState =
  | 'SELF'
  | 'NONE'
  | 'OUTGOING_PENDING'
  | 'INCOMING_PENDING'
  | 'FRIEND';

@Component({
  selector: 'app-contact-identity-dialog',
  standalone: true,
  imports: [SnapshotAvatarComponent, TranslocoPipe, DialogActionFooterComponent],
  templateUrl: './contact-identity-dialog.component.html',
  styleUrl: './contact-identity-dialog.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContactIdentityDialogComponent {
  private readonly route = inject(RouteService);
  private readonly nav = inject(NavStateMachineService);
  private readonly userService = inject(UserService);
  private readonly localDomain = inject(LocalDomainService);
  readonly identity = input.required<ContactIdentityDialogData>();
  readonly relationship = signal<RelationshipState | undefined>(undefined);
  readonly optimisticFriendThreadId = signal<number | undefined>(undefined);
  readonly joiningGroup = signal(false);
  readonly groupJoinRequested = signal(false);
  readonly effectiveRelationship = computed(
    () =>
      this.relationship() ??
      this.identity().relationship ??
      (this.identity().friendThreadId === undefined ? 'NONE' : 'FRIEND'),
  );
  readonly isGroup = computed(() => this.identity().account.startsWith('!'));
  readonly avatarType = computed(() =>
    this.isGroup() ? UserAvatarType.GROUP : UserAvatarType.OTHER,
  );
  readonly displayDomain = computed(() => this.identity().domain);
  readonly isLocalDomain = computed(
    () => this.identity().domain === this.localDomain.domain(),
  );
  readonly actionKey = computed(() => {
    const identity = this.identity();
    if (this.isGroup())
      return identity.groupThreadId === undefined
        ? this.groupJoinRequested()
          ? 'friend.sentStatus'
          : 'friend.joinGroup'
        : 'contactCard.enterGroup';
    switch (this.effectiveRelationship()) {
      case 'SELF':
        return null;
      case 'OUTGOING_PENDING':
        return 'friend.sentStatus';
      case 'INCOMING_PENDING':
        return 'friend.reviewRequest';
      case 'FRIEND':
        return 'profile.openChat';
      default:
        return 'friend.addAction';
    }
  });

  readonly actionDisabled = computed(
    () =>
      this.effectiveRelationship() === 'OUTGOING_PENDING' ||
      this.groupJoinRequested() ||
      this.joiningGroup() ||
      (this.effectiveRelationship() === 'FRIEND' &&
        this.identity().friendThreadId === undefined &&
        this.optimisticFriendThreadId() === undefined),
  );

  constructor() {
    effect(() => {
      const identity = this.identity();
      if (this.isGroup()) {
        if (identity.groupThreadId !== undefined) return;
        void this.userService
          .listLocalFriendRequests('OUTGOING', null, 200)
          .then((page) =>
            this.groupJoinRequested.set(
              page.items.some(
                (item) =>
                  item.kind === 'GROUP' &&
                  item.status === 'REQUESTED' &&
                  item.group?.account === identity.account &&
                  item.group?.namespaceId === identity.namespaceId,
              ),
            ),
          );
        return;
      }
      if (
        identity.relationship === 'SELF' ||
        identity.friendThreadId !== undefined
      )
        return;
      void this.userService
        .localRelationship({
          id: identity.userId ?? 0,
          account: identity.account,
          namespaceId: identity.namespaceId,
        })
        .then((state) => this.relationship.set(state));
    });
  }

  cancel(): void {
    this.route.closeDlg();
  }

  act(): void {
    if (this.actionDisabled()) return;
    const identity = this.identity();
    const threadId = this.isGroup()
      ? identity.groupThreadId
      : (identity.friendThreadId ?? this.optimisticFriendThreadId());
    if (threadId !== undefined) {
      this.route.closeDlg();
      this.nav.openChat(threadId);
      return;
    }
    if (this.isGroup()) {
      this.openGroupJoinRequest(identity);
      return;
    }
    if (this.effectiveRelationship() === 'INCOMING_PENDING') {
      this.route.closeDlg();
      this.route.popupDlg(PopupType.FRIEND_REQUESTS, {
        initialTab: 'pending',
      });
      return;
    }
    this.route.closeDlg();
    this.route.popupDlg(PopupType.FRIEND_REQUESTS, {
      initialUser: {
        id: identity.namespaceId === 0 ? (identity.userId ?? 0) : 0,
        account: identity.account,
        name: identity.name,
        avatar: identity.avatar ?? '',
        bio: identity.bio ?? '',
        domain: identity.domain,
        namespaceId: identity.namespaceId,
        isGroup: false,
      },
    });
  }

  private openGroupJoinRequest(identity: ContactIdentityDialogData): void {
    const open = (user: UserRef) => {
      this.route.closeDlg();
      this.route.popupDlg(PopupType.FRIEND_INVITE, { user, standalone: true });
    };
    const user: UserRef = {
      id: identity.userId ?? 0,
      account: identity.account,
      name: identity.name,
      avatar: identity.avatar ?? '',
      bio: identity.bio ?? '',
      domain: identity.domain,
      isGroup: true,
      namespaceId: identity.namespaceId,
    };
    open(user);
  }
}
