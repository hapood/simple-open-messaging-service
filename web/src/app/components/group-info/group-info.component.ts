import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { UserListComponent } from '../user-list/user-list.component';
import { RouteService, PopupType } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { MatButtonModule } from '@angular/material/button';
import { FormsModule } from '@angular/forms';
import { GroupService, GroupMember } from '../../services/group.service';
import { UserService } from '../../services/user.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { ConversationItem } from '../../services/model';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import { apiPrefix } from '../../services/constants';

type Role = 'OWNER' | 'ADMIN' | 'MEMBER';

/**
 * Group info panel: identity (editable by admin+), roster with roles, and the role-gated membership
 * actions (set-role / transfer / kick / leave / invite). Reused in two hosts — the desktop side panel
 * (closeFn closes the panel) and the mobile popup (closeDlg pops the dialog).
 *
 * Authorization is mirrored from the server: the owner manages admins/members and may transfer; admins
 * may kick members; everyone may leave (the owner must transfer first). The server enforces every rule
 * regardless of what this client shows.
 */
@Component({
  selector: 'app-group-info',
  imports: [UserListComponent, IconComponent, MatButtonModule, FormsModule, FitDialogDirective, UserAvatarComponent],
  templateUrl: './group-info.component.html',
  styleUrl: './group-info.component.scss',
})
export class GroupInfoComponent implements OnInit {
  readonly AppIconType = AppIconType
  readonly UserAvatarType = UserAvatarType
  readonly fitOpts = { settleMs: 600, minHeight: 360 } as const
  readonly userMsgTrd = input<ConversationItem>()
  /** optional close handler; when set, goBack() calls it instead of closeDlg. */
  readonly closeFn = input<(() => void) | undefined>(undefined)

  private readonly groupService = inject(GroupService)
  private readonly userService = inject(UserService)
  private readonly convList = inject(ConversationListService)
  private readonly routeService = inject(RouteService)
  private readonly http = inject(HttpClient)

  readonly roster = signal<GroupMember[]>([])
  readonly loading = signal(true)
  readonly busy = signal(false) // a mutation is in flight (disables action buttons)

  /** Invite picker state. */
  readonly selectedDict = signal<Record<number, boolean | undefined>>({})
  readonly selectedList = signal<ConversationItem[]>([])
  readonly showInvite = signal(false)

  /** Inline identity-edit mode (admin+). */
  readonly editing = signal(false)
  readonly nameEdit = signal('')
  /** staged new avatar URL (uploaded already); undefined = unchanged. */
  readonly pendingAvatar = signal<string | undefined>(undefined)

  /** Per-member action menu — the userId whose action sheet is open. */
  readonly openMenuFor = signal<number | undefined>(undefined)
  /** Two-step destructive confirm: { userId, action } awaiting [Confirm]. */
  readonly confirmAction = signal<{ userId: number; action: 'kick' | 'transfer' } | null>(null)

  readonly myUserId = computed(() => this.userService.sessionProfile()?.id)
  /** Caller's role, derived from the roster (fresh after each reload); falls back to the item's role. */
  readonly myRole = computed<Role | undefined>(() => {
    const me = this.roster().find((m) => m.userId === this.myUserId())
    return me?.role ?? this.userMsgTrd()?.role ?? undefined
  })
  readonly isOwner = computed(() => this.myRole() === 'OWNER')
  readonly isAdmin = computed(() => this.myRole() === 'OWNER' || this.myRole() === 'ADMIN')

  readonly group = computed(() => this.userMsgTrd()?.group)
  readonly groupId = computed(() => this.group()?.id)
  /** The avatar currently shown: the staged edit, else the persisted one. */
  readonly avatarUrl = computed(() => this.pendingAvatar() ?? this.group()?.avatar ?? '')

  ngOnInit() {
    this.loadMembers()
  }

  loadMembers() {
    const id = this.groupId()
    if (id === undefined) return
    this.loading.set(true)
    this.groupService.getMembers({ groupId: id }).subscribe((res) => {
      if (res.code === 0) this.roster.set(res.data ?? [])
      this.loading.set(false)
    })
  }

  /** Whether the caller has any action available on this member row. */
  canActOn(m: GroupMember): boolean {
    const me = this.myUserId()
    if (m.userId === me) return false // never on self
    const role = this.myRole()
    if (role === 'OWNER') return m.role !== 'OWNER' // owner acts on every non-owner
    if (role === 'ADMIN') return m.role === 'MEMBER' // admin only on members
    return false
  }

  /** The non-current role an owner can switch a member to (admin↔member toggle; never OWNER). */
  toggleRoleLabel(m: GroupMember): 'ADMIN' | 'MEMBER' {
    return m.role === 'ADMIN' ? 'MEMBER' : 'ADMIN'
  }

  toggleMenu(userId: number) {
    this.openMenuFor.update((cur) => (cur === userId ? undefined : userId))
    this.confirmAction.set(null)
  }

  // ── mutations: each reloads the roster so role badges / membership reflect the server ──

  doSetRole(m: GroupMember) {
    const role = this.toggleRoleLabel(m)
    const id = this.groupId()
    if (id === undefined) return
    this.busy.set(true)
    this.groupService.setRole({ groupId: id, userId: m.userId, role }).subscribe(() => {
      this.busy.set(false)
      this.openMenuFor.set(undefined)
      this.loadMembers()
    })
  }

  askKick(m: GroupMember) {
    this.confirmAction.set({ userId: m.userId, action: 'kick' })
  }
  askTransfer(m: GroupMember) {
    this.confirmAction.set({ userId: m.userId, action: 'transfer' })
  }
  cancelConfirm() {
    this.confirmAction.set(null)
  }
  doConfirm() {
    const c = this.confirmAction()
    if (!c) return
    const m = this.roster().find((r) => r.userId === c.userId)
    if (!m) return
    if (c.action === 'kick') this.kick(m)
    else this.transfer(m)
  }

  private kick(m: GroupMember) {
    const id = this.groupId()
    if (id === undefined) return
    this.busy.set(true)
    this.groupService.kickMember({ groupId: id, userId: m.userId }).subscribe(() => {
      this.busy.set(false)
      this.openMenuFor.set(undefined)
      this.confirmAction.set(null)
      this.loadMembers()
    })
  }

  private transfer(m: GroupMember) {
    const id = this.groupId()
    if (id === undefined) return
    this.busy.set(true)
    this.groupService.transferOwnership({ groupId: id, toUserId: m.userId }).subscribe(() => {
      this.busy.set(false)
      this.openMenuFor.set(undefined)
      this.confirmAction.set(null)
      this.loadMembers()
    })
  }

  leave() {
    const id = this.groupId()
    if (id === undefined) return
    this.busy.set(true)
    this.groupService.leaveGroup({ groupId: id }).subscribe(() => {
      this.busy.set(false)
      // the conversation is gone from the caller's list; refresh the shared store, then close.
      this.convList.load()
      this.goBack()
    })
  }

  // ── identity editing (admin+) ──

  beginEdit() {
    if (!this.isAdmin() || this.group() === undefined) return
    this.nameEdit.set(this.group()!.name)
    this.pendingAvatar.set(undefined)
    this.editing.set(true)
  }
  cancelEdit() {
    this.editing.set(false)
    this.pendingAvatar.set(undefined)
  }

  /** Pick a new avatar via the cropper, upload it, stage the returned URL (not yet saved on the group). */
  pickAvatar(fileInput: HTMLInputElement) {
    const file = fileInput.files?.[0]
    fileInput.value = ''
    if (!file) return
    this.routeService.popupDlg(PopupType.AVATAR_EDITOR, { file }, (res) => {
      if (res?.file) this.uploadAvatar(res.file)
    })
  }

  private async uploadAvatar(file: File) {
    this.busy.set(true)
    let bmp: ImageBitmap
    try {
      // /upload wants the pixel dims (frontend reads them via createImageBitmap) alongside the file.
      bmp = await createImageBitmap(file)
    } catch {
      this.busy.set(false)
      return
    }
    const fd = new FormData()
    fd.append('file', file)
    fd.append('w', String(bmp.width))
    fd.append('h', String(bmp.height))
    this.http.post<{ code: number; data?: { url: string } }>(`${apiPrefix}/upload`, fd).subscribe({
      next: (res) => {
        this.busy.set(false)
        if (res?.code === 0 && res.data?.url) this.pendingAvatar.set(res.data.url)
      },
      error: () => this.busy.set(false),
    })
  }

  saveEdit() {
    const id = this.groupId()
    if (id === undefined) return
    const name = this.nameEdit().trim()
    if (!name) return
    const avatar = this.pendingAvatar()
    this.busy.set(true)
    this.groupService
      .updateGroup({ groupId: id, name, avatar })
      .subscribe(() => {
        this.busy.set(false)
        this.editing.set(false)
        // The persisted group name/avatar changed; refresh the shared conversation list so the chat
        // list + the open chat header re-render with the new identity.
        this.convList.load()
        // Update the input's group object in place so this panel flips to the new identity instantly
        // (inputs are readonly; reflect via the roster reload + the conversation-list refresh above).
        this.loadMembers()
      })
  }

  // ── invite (add members) ──

  onTrdSelect(trdItem: ConversationItem) {
    let dict = { ...this.selectedDict() }
    let list = this.selectedList()
    if (dict[trdItem.id]) {
      dict[trdItem.id] = false
      list = list.filter((item) => item.id !== trdItem.id)
    } else {
      dict[trdItem.id] = true
      list = list.concat(trdItem)
    }
    this.selectedDict.set(dict)
    this.selectedList.set(list)
  }

  invite() {
    const list = this.selectedList()
    const id = this.groupId()
    if (id === undefined) return
    list.forEach((item) => {
      this.groupService.inviteUser({ groupId: id, userId: item.peerUser.id }).subscribe()
    })
    this.selectedDict.set({})
    this.selectedList.set([])
    this.showInvite.set(false)
  }

  goBack() {
    const fn = this.closeFn()
    if (fn) fn()
    else this.routeService.closeDlg()
  }
}
