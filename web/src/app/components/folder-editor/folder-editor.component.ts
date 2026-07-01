import { Component, input, signal, computed, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { RouteService } from '../../services/route.service';
import { FolderService, ChatFolder, FolderTypeFilter } from '../../services/folder.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { UserService } from '../../services/user.service';
import { ConversationItem } from '../../services/model';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';

/**
 * Folder management dialog (desktop). Two-pane:
 *  - list view: existing folders + "new" entry
 *  - edit form: name / type rule / included threads / delete
 * Opened via PopupType.FOLDER_EDITOR; persists through FolderService (localStorage).
 */
@Component({
  selector: 'app-folder-editor',
  imports: [FormsModule, MatButtonModule, IconComponent, FitDialogDirective],
  templateUrl: './folder-editor.component.html',
  styleUrl: './folder-editor.component.scss'
})
export class FolderEditorComponent implements OnInit {
  private readonly routeService = inject(RouteService)
  private readonly folderService = inject(FolderService)
  private readonly userService = inject(UserService)

  /** when passed via popupDlg, jumps straight into editing that folder */
  readonly folderId = input<string | undefined>(undefined)

  readonly AppIconType = AppIconType
  readonly fitOpts = { minHeight: 360 } as const

  /** false = list view, true = edit form */
  readonly editing = signal(false)
  /** true while editing an existing folder (drives update vs create + delete btn) */
  readonly isEditingExisting = signal(false)
  readonly name = signal('')
  readonly typeFilter = signal<FolderTypeFilter>('ALL')
  readonly includedIds = signal<number[]>([])
  readonly threadOptions = signal<ConversationItem[]>([])

  /** id of the folder being edited; undefined when creating */
  private editingExistingId: string | undefined

  readonly folders = computed(() => this.folderService.folders())

  readonly typeOptions: ReadonlyArray<{ value: FolderTypeFilter; label: string }> = [
    { value: 'ALL', label: 'All types' },
    { value: 'P2P', label: 'Direct' },
    { value: 'GROUP', label: 'Group' },
  ]

  ngOnInit() {
    // load thread candidates for the "included threads" picker
    this.userService.queryUserThreadValid({ take: 200, skip: 0 }).subscribe(res => {
      if (res.code === 0) this.threadOptions.set(res.data ?? [])
    })
    // open straight onto a specific folder when invoked with its id
    if (this.folderId()) {
      const f = this.folderService.getById(this.folderId()!)
      if (f) this.beginEdit(f)
    }
  }

  summary(f: ChatFolder): string {
    const t = f.typeFilter === 'ALL' ? 'All types' : f.typeFilter === 'P2P' ? 'Direct' : 'Group'
    return f.includedIds.length ? `${t} · ${f.includedIds.length} selected` : t
  }

  threadLabel(t: ConversationItem): string {
    return t.type === 'P2P' ? (t.peerUser?.uniqName ?? '') : (t.group?.name ?? '')
  }

  beginCreate() {
    this.editingExistingId = undefined
    this.isEditingExisting.set(false)
    this.name.set('')
    this.typeFilter.set('ALL')
    this.includedIds.set([])
    this.editing.set(true)
  }

  beginEdit(f: ChatFolder) {
    this.editingExistingId = f.id
    this.isEditingExisting.set(true)
    this.name.set(f.name)
    this.typeFilter.set(f.typeFilter)
    this.includedIds.set([...f.includedIds])
    this.editing.set(true)
  }

  toggleInclude(id: number) {
    const ids = this.includedIds()
    this.includedIds.set(ids.includes(id) ? ids.filter(x => x !== id) : ids.concat([id]))
  }

  backToList() {
    this.editing.set(false)
  }

  save() {
    const name = this.name().trim()
    if (!name) return
    const payload = { name, typeFilter: this.typeFilter(), includedIds: this.includedIds() }
    if (this.editingExistingId) this.folderService.update(this.editingExistingId, payload)
    else this.folderService.create(payload)
    this.routeService.closeDlg(true)
  }

  remove() {
    if (this.editingExistingId) this.folderService.remove(this.editingExistingId)
    this.routeService.closeDlg(true)
  }

  goBack() {
    this.routeService.closeDlg()
  }
}
