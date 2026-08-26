import {
  Component,
  computed,
  effect,
  inject,
  OnInit,
  OnDestroy,
  signal,
  untracked,
  ChangeDetectionStrategy,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NavStateMachineService } from '../../services/nav-state.service';
import { Subscription, firstValueFrom } from 'rxjs';
import { UserListComponent } from '../user-list/user-list.component';
import { RouteService, PopupType } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { MatButtonModule } from '@angular/material/button';
import { MatSlideToggleModule } from '@angular/material/slide-toggle';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatMenuModule } from '@angular/material/menu';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FormsModule } from '@angular/forms';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { GroupService } from '../../services/group.service';
import { UserService } from '../../services/user.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { ConversationItem, P2PConversationItem } from '../../services/model';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { ThreadAliasEditorComponent } from '../thread-alias-editor/thread-alias-editor.component';
import { apiPrefix } from '../../services/constants';
import { finalize } from 'rxjs';
import { translateBizResult } from '../../services/biz-code';
import { ToastService } from '../../services/toast.service';
import { MESSAGE_THREAD_ADAPTER } from '../message-thread/message-thread-adapter';
import {
  MemberProfileRepository,
  type ResolvedMemberProfile,
} from '../../services/member-profile-store.service';
import { PageHeaderComponent } from '../page-header/page-header.component';
import { ChatContextService } from '../message-thread/chat-context.service';

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

/**
 * Group info panel: identity (editable by admin+), roster with roles, and the role-gated membership
 * actions (set-role / transfer / kick / leave / invite). Rendered in the `aside` auxiliary outlet
 * (`chat/:threadId/(aside:group-info)`); it resolves its conversation from the parent route's
 * `:threadId` + the shared list.
 *
 * Authorization is mirrored from the server: the owner manages admins/members and may transfer; admins
 * may kick members; everyone may leave (the owner must transfer first). The server enforces every rule
 * regardless of what this client shows.
 */
@Component({
  selector: 'app-group-info',
  imports: [
    UserListComponent,
    IconComponent,
    MatButtonModule,
    MatSlideToggleModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
    FormsModule,
    UserAvatarComponent,
    TranslocoPipe,
    ThreadAliasEditorComponent,
    PageHeaderComponent,
  ],
  templateUrl: './group-info.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './group-info.component.scss',
})
export class GroupInfoComponent implements OnInit, OnDestroy {
  readonly AppIconType = AppIconType;
  readonly UserAvatarType = UserAvatarType;

  private readonly nav = inject(NavStateMachineService);
  private readonly groupService = inject(GroupService);
  private readonly memberProfiles = inject(MemberProfileRepository);
  private readonly userService = inject(UserService);
  private readonly convList = inject(ConversationListService);
  private readonly routeService = inject(RouteService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly http = inject(HttpClient);
  private readonly transloco = inject(TranslocoService);
  private readonly toast = inject(ToastService);
  private readonly threadAdapter = inject(MESSAGE_THREAD_ADAPTER);
  private readonly chatContext = inject(ChatContextService);

  /** The open thread id (template-bound for the alias editor). */
  readonly threadId = this.convList.openThreadId;
  /** The panel is open over the currently-viewed chat — read its id + item from the shared list. */
  readonly userMsgTrd = computed<ConversationItem | undefined>(() => {
    const id = this.convList.openThreadId();
    return id !== undefined
      ? this.convList.items().find((t) => t.threadId === id)
      : undefined;
  });

  /** Live display-profile refresh subscription for the currently open group. */
  private rosterSub?: Subscription;

  readonly roster = signal<ResolvedMemberProfile[]>([]);
  readonly loading = signal(true);
  readonly loadingMore = signal(false);
  readonly rosterHasMore = signal(false);
  readonly busy = signal(false); // a mutation is in flight (disables action buttons)
  readonly blockedSaving = signal(false);
  readonly blockedControl = signal(false);

  /** Invite picker state. */
  readonly selectedDict = signal<Record<number, boolean | undefined>>({});
  readonly selectedList = signal<P2PConversationItem[]>([]);
  readonly showInvite = signal(false);
  readonly showMemberManager = signal(false);
  readonly memberQuery = signal('');
  readonly inviteQuery = signal('');

  /** Whether the admin-only group-profile editor is open as a second-level panel. */
  readonly editing = signal(false);
  readonly nameEdit = signal('');
  /** Max length of the group description. */
  readonly DESC_MAX = 240;
  /** Staged description while editing (admin+); seeded from the current value on beginEdit. */
  readonly descEdit = signal('');
  /** staged new avatar URL (uploaded already); undefined = unchanged. */
  readonly pendingAvatar = signal<string | undefined>(undefined);

  readonly myUserId = computed(() => this.userService.sessionProfile()?.id);
  /** Caller's role comes from the chatbox context initialized when this chat was opened. */
  readonly myRole = this.chatContext.groupRole;
  readonly isOwner = computed(() => this.myRole() === 'OWNER');
  readonly isAdmin = computed(
    () => this.myRole() === 'OWNER' || this.myRole() === 'ADMIN',
  );
  readonly overviewMembers = computed(() => this.roster().slice(0, 5));
  readonly remainingMemberCount = computed(() =>
    Math.max(
      0,
      (this.group()?.memberCount ?? 0) - this.overviewMembers().length,
    ),
  );
  readonly filteredRoster = this.roster.asReadonly();
  readonly canInvite = this.isAdmin;
  readonly existingMemberIds = computed(
    () => new Set(this.roster().map((member) => member.userId)),
  );
  readonly canLeave = computed(() => !this.isOwner());
  readonly confirmDissolve = signal(false);

  readonly group = computed(() => this.userMsgTrd()?.group);
  readonly dissolved = computed(() => this.group()?.dissolvedAt != null);
  readonly readOnly = computed(
    () =>
      this.dissolved() || this.userMsgTrd()?.conversationState === 'READ_ONLY',
  );
  readonly groupId = computed(() => this.group()?.id);
  /** The avatar currently shown: the staged edit, else the persisted one. */
  readonly avatarUrl = computed(
    () => this.pendingAvatar() ?? this.group()?.avatar ?? '',
  );

  constructor() {
    effect(() => {
      const threadId = this.threadId();
      const groupMetaFeedId = this.group()?.groupMetaFeedId;
      const search = this.memberQuery();
      if (threadId !== undefined && groupMetaFeedId !== undefined) {
        void search;
        untracked(() => void this.loadMembers());
      }
    });
    effect(() => {
      const blocked = this.userMsgTrd()?.blocked === true;
      if (!this.blockedSaving())
        untracked(() => this.blockedControl.set(blocked));
    });
  }

  ngOnInit() {
    this.rosterSub = this.memberProfiles.changed$.subscribe((threadIds) => {
      const threadId = this.threadId();
      if (threadId !== undefined && threadIds.includes(threadId))
        void this.loadMembers();
    });
  }

  ngOnDestroy() {
    this.rosterSub?.unsubscribe();
  }

  async loadMembers() {
    const threadId = this.threadId();
    if (threadId === undefined) return;
    this.loading.set(true);
    const resolved = await this.memberProfiles.queryPage(threadId, {
      take: 50,
      search: this.memberQuery(),
    });
    this.roster.set(resolved);
    this.rosterHasMore.set(resolved.length === 50);
    const memberIds = new Set(resolved.map((member) => member.userId));
    this.selectedList.update((list) =>
      list.filter((item) => !memberIds.has(item.peerUser.id)),
    );
    this.selectedDict.update((dict) => {
      const next = { ...dict };
      for (const item of this.convList.items()) {
        if (item.type === 'P2P' && memberIds.has(item.peerUser.id))
          next[item.threadId] = false;
      }
      return next;
    });
    this.loading.set(false);
  }

  async loadMoreMembers(): Promise<void> {
    const threadId = this.threadId();
    const current = this.roster();
    if (
      threadId === undefined ||
      !this.rosterHasMore() ||
      this.loadingMore() ||
      current.length === 0
    )
      return;
    this.loadingMore.set(true);
    try {
      const page = await this.memberProfiles.queryPage(threadId, {
        afterUserId: current.at(-1)!.userId,
        take: 50,
        search: this.memberQuery(),
      });
      this.roster.update((members) => [...members, ...page]);
      this.rosterHasMore.set(page.length === 50);
    } finally {
      this.loadingMore.set(false);
    }
  }

  onRosterScroll(event: Event): void {
    const element = event.currentTarget as HTMLElement;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 160)
      void this.loadMoreMembers();
  }

  /** Whether the caller has any action available on this member row. */
  canActOn(m: ResolvedMemberProfile): boolean {
    const me = this.myUserId();
    if (m.userId === me) return false; // never on self
    const role = this.myRole();
    if (role === 'OWNER') return m.role !== 'OWNER'; // owner acts on every non-owner
    if (role === 'ADMIN') return m.role === 'MEMBER'; // admin only on members
    return false;
  }

  /** The non-current role an owner can switch a member to (admin↔member toggle; never OWNER). */
  toggleRoleLabel(m: ResolvedMemberProfile): 'ADMIN' | 'MEMBER' {
    return m.role === 'ADMIN' ? 'MEMBER' : 'ADMIN';
  }
  /** Localized role name for badges / the "Make …" action (reads the active language). */
  roleName(role: string): string {
    return this.transloco.translate('group.role.' + role.toLowerCase());
  }
  // ── mutations: each reloads the roster so role badges / membership reflect the server ──

  doSetRole(m: ResolvedMemberProfile) {
    const role = this.toggleRoleLabel(m);
    const settingAdmin = role === 'ADMIN';
    this.routeService.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: settingAdmin ? 'group.setAdmin' : 'group.unsetAdmin',
        messageKey: settingAdmin
          ? 'group.setAdminConfirm'
          : 'group.unsetAdminConfirm',
        messageParams: { name: m.name },
        confirmKey: settingAdmin ? 'group.setAdmin' : 'group.unsetAdmin',
        cancelKey: 'common.cancel',
        icon: AppIconType.PERSON_ADMIN,
      },
      (result) => {
        if (result) this.setRole(m, role);
      },
    );
  }

  private setRole(m: ResolvedMemberProfile, role: 'ADMIN' | 'MEMBER') {
    const id = this.groupId();
    if (id === undefined) return;
    this.busy.set(true);
    this.groupService
      .setRole({ groupId: id, userId: m.userId, role })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code !== 0) return this.showBusinessError(res);
          this.loadMembers();
        },
        error: () => this.showNetworkError(),
      });
  }

  askKick(m: ResolvedMemberProfile) {
    this.routeService.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'group.kick',
        messageKey: 'group.kickConfirm',
        messageParams: { name: m.name },
        confirmKey: 'group.kick',
        cancelKey: 'common.cancel',
        icon: AppIconType.PERSON_REMOVE,
      },
      (result) => {
        if (result) this.kick(m);
      },
    );
  }
  askTransfer(m: ResolvedMemberProfile) {
    this.routeService.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'group.transferOwner',
        messageKey: 'group.transferOwnerConfirm',
        messageParams: { name: m.name },
        confirmKey: 'group.confirmTransfer',
        cancelKey: 'common.cancel',
        danger: true,
      },
      (result) => {
        if (result) this.transfer(m);
      },
    );
  }

  private kick(m: ResolvedMemberProfile) {
    const id = this.groupId();
    if (id === undefined) return;
    this.busy.set(true);
    this.groupService
      .kickMember({ groupId: id, userId: m.userId })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code !== 0) return this.showBusinessError(res);
          this.loadMembers();
        },
        error: () => this.showNetworkError(),
      });
  }

  private transfer(m: ResolvedMemberProfile) {
    const id = this.groupId();
    if (id === undefined) return;
    this.busy.set(true);
    this.groupService
      .transferOwnership({ groupId: id, toUserId: m.userId })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code !== 0) return this.showBusinessError(res);
          this.loadMembers();
        },
        error: () => this.showNetworkError(),
      });
  }

  confirmLeave() {
    if (this.isOwner()) {
      this.routeService.popupDlg(
        PopupType.CONFIRM,
        {
          titleKey: 'group.leaveOwnerTitle',
          messageKey: 'group.leaveOwnerConfirm',
          confirmKey: 'group.transferIdentity',
          cancelKey: 'common.cancel',
        },
        (result) => {
          if (!result) return;
          this.showMemberManager.set(true);
        },
      );
      return;
    }
    this.routeService.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'chat.leaveConfirmTitle',
        messageKey: 'chat.menuLeaveGroupConfirm',
        confirmKey: 'group.leave',
        cancelKey: 'common.cancel',
        danger: true,
      },
      (result) => {
        if (!result) return;
        void this.leave();
      },
    );
  }

  private async leave() {
    const id = this.groupId();
    if (id === undefined || !this.canLeave() || this.busy()) return;
    this.busy.set(true);
    try {
      const res = await firstValueFrom(
        this.groupService.leaveGroup({ groupId: id }),
      );
      if (res.code !== 0) return this.showBusinessError(res);
      this.convList.applyThreadMeta(id, { conversationState: 'READ_ONLY' });
      this.nav.closeAside();
    } catch {
      this.showNetworkError();
    } finally {
      this.busy.set(false);
      this.convList.load();
    }
  }

  confirmDissolveAction() {
    this.routeService.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'group.dissolve',
        messageKey: 'group.dissolveConfirm',
        confirmKey: 'group.dissolve',
        cancelKey: 'common.cancel',
        danger: true,
      },
      (result) => {
        if (!result) return;
        void this.dissolve();
      },
    );
  }

  private async dissolve() {
    const id = this.groupId();
    if (
      id === undefined ||
      !this.isOwner() ||
      this.readOnly() ||
      this.busy()
    )
      return;
    this.busy.set(true);
    try {
      const res = await firstValueFrom(
        this.groupService.dissolveGroup({ groupId: id }),
      );
      if (res.code !== 0) return this.showBusinessError(res);
      this.convList.applyGroupUpdate(id, { dissolvedAt: Date.now() });
      this.convList.applyThreadMeta(id, { conversationState: 'READ_ONLY' });
      this.nav.closeAside();
    } catch {
      this.showNetworkError();
    } finally {
      this.busy.set(false);
      this.convList.load();
    }
  }

  setBlocked(blocked: boolean): void {
    const trd = this.userMsgTrd();
    if (!trd || this.blockedSaving()) return;
    this.blockedControl.set(blocked);
    this.blockedSaving.set(true);
    this.threadAdapter
      .setBlocked({ threadId: trd.threadId, blocked })
      .pipe(finalize(() => this.blockedSaving.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code !== 0) {
            this.blockedControl.set(!blocked);
            return this.showBusinessError(res);
          }
          this.convList.applyThreadMeta(trd.threadId, { blocked });
        },
        error: () => {
          this.blockedControl.set(!blocked);
          this.showNetworkError();
        },
      });
  }

  // ── identity editing (admin+) ──

  beginEdit() {
    if (!this.isAdmin() || this.readOnly() || this.group() === undefined)
      return;
    this.nameEdit.set(this.group()!.name);
    this.descEdit.set(this.group()!.description ?? '');
    this.pendingAvatar.set(undefined);
    this.editing.set(true);
  }
  cancelEdit() {
    this.editing.set(false);
    this.pendingAvatar.set(undefined);
  }

  /** Pick a new avatar via the cropper, upload it, stage the returned URL (not yet saved on the group). */
  pickAvatar(fileInput: HTMLInputElement) {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    this.routeService.popupDlg(PopupType.AVATAR_EDITOR, { file }, (res) => {
      if (res?.file) this.uploadAvatar(res.file);
    });
  }

  private uploadAvatar(file: File) {
    this.busy.set(true);
    // /upload/avatar runs the server-side sharp cover-crop, so it needs only the file (no w/h —
    // avatars are square). Returns { avatar } (a /uploads/avatars/ url) which we stage on the group.
    const fd = new FormData();
    fd.append('file', file);
    this.http
      .post<{
        code: number;
        data?: { avatar: string };
      }>(`${apiPrefix()}/upload/avatar`, fd)
      .subscribe({
        next: (res) => {
          this.busy.set(false);
          if (res?.code === 0 && res.data?.avatar)
            this.pendingAvatar.set(res.data.avatar);
        },
        error: () => this.busy.set(false),
      });
  }

  saveEdit() {
    const id = this.groupId();
    if (id === undefined) return;
    const name = this.nameEdit().trim();
    if (!name) return;
    const avatar = this.pendingAvatar();
    this.busy.set(true);
    this.groupService
      .updateGroup({ groupId: id, name, description: this.descEdit(), avatar })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code !== 0) return this.showBusinessError(res);
          this.editing.set(false);
          // The persisted group name/avatar changed; refresh the shared conversation list so the chat
          // list + the open chat header re-render with the new identity.
          this.convList.load();
          // Update the input's group object in place so this panel flips to the new identity instantly
          // (inputs are readonly; reflect via the roster reload + the conversation-list refresh above).
          this.loadMembers();
        },
        error: () => this.showNetworkError(),
      });
  }

  // ── invite (add members) ──

  onTrdSelect(trdItem: P2PConversationItem) {
    let dict = { ...this.selectedDict() };
    let list = this.selectedList();
    if (dict[trdItem.threadId]) {
      dict[trdItem.threadId] = false;
      list = list.filter((item) => item.threadId !== trdItem.threadId);
    } else {
      dict[trdItem.threadId] = true;
      list = list.concat(trdItem);
    }
    this.selectedDict.set(dict);
    this.selectedList.set(list);
  }

  invite() {
    const list = this.selectedList();
    const id = this.groupId();
    if (id === undefined || list.length === 0) return;
    // One batched request (the server writes one INVITE per friend in their P2P thread). Busy gates
    // the button; the response carries invited/skipped counts surfaced via a snackbar. The roster is
    // NOT reloaded here — invitees are not members until they accept; they appear live via
    // The durable group-state delta refreshes this roster once they join.
    const existing = this.existingMemberIds();
    const userIds = list
      .map((item) => item.peerUser.id)
      .filter((userId) => !existing.has(userId));
    if (userIds.length === 0) return;
    this.busy.set(true);
    this.groupService
      .inviteUsers({ groupId: id, userIds })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code !== 0) return this.showBusinessError(res);
          const invited = res.data?.invited?.length ?? 0;
          const skipped = res.data?.skipped?.length ?? 0;
          const msg =
            skipped > 0
              ? this.transloco.translate('errors.invitedPartial', {
                  n: invited,
                  skipped,
                })
              : invited > 0
                ? this.transloco.translate('errors.invited', { n: invited })
                : this.transloco.translate('errors.noInvites');
          this.snackBar.open(msg, this.transloco.translate('common.ok'), {
            duration: 4000,
          });
          this.selectedDict.set({});
          this.selectedList.set([]);
          this.showInvite.set(false);
        },
        error: () => this.showNetworkError(),
      });
  }

  private showBusinessError(res: {
    code: number;
    message: string;
    messageKey?: string;
  }) {
    this.toast.warn(translateBizResult(res, this.transloco));
  }

  private showNetworkError() {
    this.toast.warn(this.transloco.translate('errors.networkError'));
  }

  /** Close the aside (back to the chat). Clears the aside signal — back won't re-open it. */
  goBack() {
    this.nav.closeAside();
  }
}
