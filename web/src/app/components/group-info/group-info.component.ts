import {
  Component,
  computed,
  effect,
  inject,
  OnInit,
  OnDestroy,
  signal,
} from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { NavStateMachineService } from '../../services/nav-state.service';
import { Subscription, firstValueFrom } from 'rxjs';
import { UserListComponent } from '../user-list/user-list.component';
import { RouteService, PopupType } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { FormsModule } from '@angular/forms';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { GroupService } from '../../services/group.service';
import { UserService } from '../../services/user.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { ConversationItem } from '../../services/model';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../user-avatar/user-avatar.component';
import { ThreadAliasEditorComponent } from '../thread-alias-editor/thread-alias-editor.component';
import { FederatedBadgeComponent } from '../federated-badge/federated-badge.component';
import { apiPrefix } from '../../services/constants';
import { finalize } from 'rxjs';
import { translateBizResult } from '../../services/biz-code';
import { ToastService } from '../../services/toast.service';
import { ThreadDeletionLockService } from '../../services/thread-deletion-lock.service';
import { MsgService } from '../../services/message.service';
import {
  MemberProfileRepository,
  type ResolvedMemberProfile,
} from '../../services/member-profile-store.service';

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
    FormsModule,
    UserAvatarComponent,
    TranslocoPipe,
    ThreadAliasEditorComponent,
    FederatedBadgeComponent,
  ],
  templateUrl: './group-info.component.html',
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
  private readonly deletionLock = inject(ThreadDeletionLockService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly http = inject(HttpClient);
  private readonly transloco = inject(TranslocoService);
  private readonly toast = inject(ToastService);
  private readonly msgService = inject(MsgService);

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
  readonly busy = signal(false); // a mutation is in flight (disables action buttons)

  /** Invite picker state. */
  readonly selectedDict = signal<Record<number, boolean | undefined>>({});
  readonly selectedList = signal<ConversationItem[]>([]);
  readonly showInvite = signal(false);
  readonly memberQuery = signal('');

  /** Inline identity-edit mode (admin+). */
  readonly editing = signal(false);
  readonly nameEdit = signal('');
  /** Max length of the group description. */
  readonly DESC_MAX = 240;
  /** Staged description while editing (admin+); seeded from the current value on beginEdit. */
  readonly descEdit = signal('');
  /** staged new avatar URL (uploaded already); undefined = unchanged. */
  readonly pendingAvatar = signal<string | undefined>(undefined);

  /** Per-member action menu — the userId whose action sheet is open. */
  readonly openMenuFor = signal<number | undefined>(undefined);
  /** Two-step destructive confirm: { userId, action } awaiting [Confirm]. */
  readonly confirmAction = signal<{
    userId: number;
    action: 'kick' | 'transfer';
  } | null>(null);

  readonly myUserId = computed(() => this.userService.sessionProfile()?.id);
  /** Caller's role, derived from the roster (fresh after each reload); falls back to the item's role. */
  readonly myRole = computed<Role | undefined>(() => {
    const me = this.roster().find((m) => m.userId === this.myUserId());
    return me?.role ?? this.userMsgTrd()?.role ?? undefined;
  });
  readonly isOwner = computed(() => this.myRole() === 'OWNER');
  readonly isAdmin = computed(
    () => this.myRole() === 'OWNER' || this.myRole() === 'ADMIN',
  );
  readonly overviewMembers = computed(() => this.roster().slice(0, 5));
  readonly remainingMemberCount = computed(() =>
    Math.max(0, this.roster().length - this.overviewMembers().length),
  );
  readonly filteredRoster = computed(() => {
    const q = this.memberQuery().trim().toLocaleLowerCase();
    if (!q) return this.roster();
    return this.roster().filter((member) =>
      `${member.name} ${member.account}`.toLocaleLowerCase().includes(q),
    );
  });
  readonly canInvite = computed(
    () => this.isAdmin() || this.group()?.membersCanInvite !== false,
  );
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
      const members = this.group()?.members;
      if (threadId !== undefined && members) void this.loadMembers();
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
    const members = this.group()?.members ?? [];
    if (threadId === undefined) return;
    this.loading.set(true);
    const resolved = await this.memberProfiles.resolveAll(threadId, members);
    this.roster.set(resolved);
    const memberIds = new Set(resolved.map((member) => member.userId));
    this.selectedList.update((list) =>
      list.filter((item) => !memberIds.has(item.peerUser.id)),
    );
    this.selectedDict.update((dict) => {
      const next = { ...dict };
      for (const item of this.convList.items()) {
        if (memberIds.has(item.peerUser?.id)) next[item.id] = false;
      }
      return next;
    });
    this.loading.set(false);
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
  /** Localized destructive-action verb for the confirm prompt (kick / transfer). */
  actionLabel(action: 'kick' | 'transfer'): string {
    return this.transloco.translate('group.action.' + action);
  }

  toggleMenu(userId: number) {
    this.openMenuFor.update((cur) => (cur === userId ? undefined : userId));
    this.confirmAction.set(null);
  }

  // ── mutations: each reloads the roster so role badges / membership reflect the server ──

  doSetRole(m: ResolvedMemberProfile) {
    const role = this.toggleRoleLabel(m);
    const id = this.groupId();
    if (id === undefined) return;
    this.busy.set(true);
    this.groupService
      .setRole({ groupId: id, userId: m.userId, role })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code !== 0) return this.showBusinessError(res);
          this.openMenuFor.set(undefined);
          this.loadMembers();
        },
        error: () => this.showNetworkError(),
      });
  }

  askKick(m: ResolvedMemberProfile) {
    this.confirmAction.set({ userId: m.userId, action: 'kick' });
  }
  askTransfer(m: ResolvedMemberProfile) {
    this.confirmAction.set({ userId: m.userId, action: 'transfer' });
  }
  cancelConfirm() {
    this.confirmAction.set(null);
  }
  doConfirm() {
    const c = this.confirmAction();
    if (!c) return;
    const m = this.roster().find((r) => r.userId === c.userId);
    if (!m) return;
    if (c.action === 'kick') this.kick(m);
    else this.transfer(m);
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
          this.openMenuFor.set(undefined);
          this.confirmAction.set(null);
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
          this.openMenuFor.set(undefined);
          this.confirmAction.set(null);
          this.loadMembers();
        },
        error: () => this.showNetworkError(),
      });
  }

  confirmLeave() {
    this.routeService.popupDlg(
      PopupType.CONFIRM,
      {
        titleKey: 'chat.leaveConfirmTitle',
        messageKey: 'chat.menuLeaveGroupConfirm',
        confirmKey: 'group.leave',
        cancelKey: 'common.cancel',
        checkboxKey: 'chat.alsoDeleteData',
        danger: true,
      },
      (result) => {
        if (!result) return;
        void this.leave(typeof result === 'object' && result.checked);
      },
    );
  }

  private async leave(deleteData: boolean) {
    const id = this.groupId();
    if (id === undefined || !this.canLeave()) return;
    if (!this.deletionLock.begin(id)) return;
    this.busy.set(true);
    try {
      const res = await firstValueFrom(
        this.groupService.leaveGroup({ groupId: id, deleteData }),
      );
      if (res.code !== 0) return this.showBusinessError(res);
      if (deleteData) {
        await this.convList.removeThread(id);
        this.nav.closeChat();
      } else {
        this.convList.applyThreadMeta(id, { conversationState: 'READ_ONLY' });
        this.nav.closeAside();
      }
    } catch {
      this.showNetworkError();
    } finally {
      this.busy.set(false);
      this.deletionLock.end(id);
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
        checkboxKey: 'chat.alsoDeleteData',
        danger: true,
      },
      (result) => {
        if (!result) return;
        void this.dissolve(typeof result === 'object' && result.checked);
      },
    );
  }

  private async dissolve(deleteData: boolean) {
    const id = this.groupId();
    if (id === undefined || !this.isOwner() || this.readOnly()) return;
    if (!this.deletionLock.begin(id)) return;
    this.busy.set(true);
    try {
      const res = await firstValueFrom(
        this.groupService.dissolveGroup({ groupId: id, deleteData }),
      );
      if (res.code !== 0) return this.showBusinessError(res);
      if (deleteData) {
        await this.convList.removeThread(id);
        this.nav.closeChat();
      } else {
        this.convList.applyGroupUpdate(id, { dissolvedAt: Date.now() });
        this.convList.applyThreadMeta(id, { conversationState: 'READ_ONLY' });
        this.nav.closeAside();
      }
    } catch {
      this.showNetworkError();
    } finally {
      this.busy.set(false);
      this.deletionLock.end(id);
      this.convList.load();
    }
  }

  toggleBlocked(): void {
    const trd = this.userMsgTrd();
    if (!trd) return;
    const blocked = !trd.blocked;
    this.msgService.setBlocked({ threadId: trd.threadId, blocked }).subscribe({
      next: (res) => {
        if (res.code !== 0) return this.showBusinessError(res);
        this.convList.applyThreadMeta(trd.threadId, { blocked });
      },
      error: () => this.showNetworkError(),
    });
  }

  setMembersCanInvite(enabled: boolean): void {
    const id = this.groupId();
    if (id === undefined || !this.isAdmin()) return;
    this.busy.set(true);
    this.groupService
      .updateGroup({ groupId: id, membersCanInvite: enabled })
      .pipe(finalize(() => this.busy.set(false)))
      .subscribe({
        next: (res) => {
          if (res.code !== 0) return this.showBusinessError(res);
          this.convList.applyGroupUpdate(id, { membersCanInvite: enabled });
        },
        error: () => this.showNetworkError(),
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

  onTrdSelect(trdItem: ConversationItem) {
    let dict = { ...this.selectedDict() };
    let list = this.selectedList();
    if (dict[trdItem.id]) {
      dict[trdItem.id] = false;
      list = list.filter((item) => item.id !== trdItem.id);
    } else {
      dict[trdItem.id] = true;
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
