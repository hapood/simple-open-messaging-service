import { Component, signal, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { MatSnackBar } from '@angular/material/snack-bar';
import { UserListComponent } from '../user-list/user-list.component';
import { RouteService, PopupType } from '../../services/route.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { MatButtonModule } from '@angular/material/button';
import { GroupService } from '../../services/group.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { ConversationItem } from '../../services/model';
import { UserService } from '../../services/user.service';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';
import { apiPrefix } from '../../services/constants';

type Step = 1 | 2;

/**
 * New-group dialog, laid out as the WhatsApp / Telegram two-step flow:
 *   1. Add members — search + removable selected chips + friend list with a brand check.
 *   2. Name + avatar — group photo (cropper → /upload) + name input with a char counter.
 *
 * Both steps stay in the DOM (toggled via `[hidden]`) so the friend list isn't refetched
 * when navigating back, and `appFitDialog` locks the card height on the taller step 1.
 */
@Component({
  selector: 'app-new-group',
  imports: [UserListComponent, IconComponent, UserAvatarComponent, MatButtonModule, FormsModule, FitDialogDirective, TranslocoPipe],
  templateUrl: './new-group.component.html',
  styleUrl: './new-group.component.scss',
})
export class NewGroupComponent {
  readonly fitOpts = { settleMs: 600, minHeight: 360 } as const
  readonly AppIconType = AppIconType
  readonly UserAvatarType = UserAvatarType
  readonly NAME_MAX = 31

  /** Wizard step: 1 = pick members, 2 = name + avatar. */
  readonly step = signal<Step>(1)
  /** Client-side filter for the friend list (display name / handle). */
  readonly searchText = signal('')
  /** Staged group avatar URL (uploaded before creation), if any. */
  readonly pendingAvatar = signal<string | undefined>(undefined)
  /** True while an avatar crop is uploading. */
  readonly busy = signal(false)

  /** Group name — defaults to a member-derived prefill (WhatsApp-style) until the user edits it. */
  readonly name = signal('')
  private nameEdited = signal(false)

  selectedDict = signal<Record<number, boolean | undefined>>({})
  selectedList = signal<ConversationItem[]>([])

  private readonly routeService = inject(RouteService)
  private readonly groupService = inject(GroupService)
  private readonly userService = inject(UserService)
  private readonly http = inject(HttpClient)
  private readonly snackBar = inject(MatSnackBar)
  private readonly transloco = inject(TranslocoService)
  private readonly convList = inject(ConversationListService)

  /** User typed into the name field → stop auto-deriving from the member set. */
  onNameInput(v: string) {
    this.name.set(v)
    this.nameEdited.set(true)
  }

  onSearchInput(v: string) {
    this.searchText.set(v)
  }

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

  /** Remove a member via its chip (step 1). */
  removeMember(item: ConversationItem) {
    const dict = { ...this.selectedDict() }
    dict[item.id] = false
    this.selectedDict.set(dict)
    this.selectedList.set(this.selectedList().filter((i) => i.id !== item.id))
  }

  /** Advance to the name/avatar step; derive a default name first unless the user typed one. */
  goStep2() {
    if (!this.nameEdited()) this.rederiveName()
    this.step.set(2)
  }

  goStep1() {
    this.step.set(1)
  }

  /** Header back: step 2 → step 1 (keep state); step 1 → close the dialog. */
  onBack() {
    if (this.step() === 2) this.goStep1()
    else this.routeService.closeDlg()
  }

  /** Derive a short group name from the creator + selected members (truncated to NAME_MAX chars). */
  private rederiveName() {
    let n = this.userService.sessionProfile()?.userExtra.name ?? ''
    for (const item of this.selectedList()) {
      n += ' ' + item.peerUser.userExtra.name
      if (n.length > 26) {
        n = n.slice(0, 22) + ' ...'
        break
      }
    }
    this.name.set(n.trim())
  }

  /** Pick a group photo via the cropper, upload it, stage the returned URL (not yet persisted). */
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
      // /upload wants the pixel dims (read via createImageBitmap) alongside the file.
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

  /** Create the group, invite the selected friends, surface the result, then close the dialog. */
  confirm() {
    const name = this.name().trim()
    if (!name) return
    // Invite the selected friends at creation — each receives a GROUP_INVITE in their P2P thread
    // and must accept via group/join (same path as group-info's "Invite" button). They are all
    // friends by construction (the picker lists conversations), so `skipped` is normally empty.
    const inviteUserIds = this.selectedList().map((item) => item.peerUser.id)
    const avatar = this.pendingAvatar()
    this.groupService.createGroup({ name, avatar, inviteUserIds }).subscribe((res) => {
      if (res.code === 0 && res.data) {
        // Reuse the same toast copy/keys as group-info's invite flow for consistency.
        const invited = res.data.invited?.length ?? 0
        const skipped = res.data.skipped?.length ?? 0
        const msg =
          skipped > 0
            ? this.transloco.translate('errors.invitedPartial', { n: invited, skipped })
            : invited > 0
              ? this.transloco.translate('errors.invited', { n: invited })
              : this.transloco.translate('errors.noInvites')
        this.snackBar.open(msg, this.transloco.translate('common.ok'), { duration: 4000 })
        // Promote the new group to the top of the list (the caller's refresh→load converges on it)
        // so it animates in via the FLIP enter rather than sinking to the bottom (empty lastMessageAt).
        this.convList.markTopOnNextUpdate(res.data.threadId)
        this.routeService.closeDlg({ groupId: res.data.groupId })
      }
    })
  }
}
