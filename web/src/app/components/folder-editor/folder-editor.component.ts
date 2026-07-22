import { Component, input, signal, computed, inject, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import { FolderService, ChatFolder, FolderTypeFilter, FolderStatusFilter } from '../../services/folder.service';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { ConversationListService } from '../../services/conversation-list.service';
import { ConversationItem } from '../../services/model';
import { LanguageService } from '../../services/language.service';
import { FitDialogDirective } from '../../directives/fit-dialog.directive';

/**
 * Folder management dialog (desktop). Two-pane:
 *  - list view: existing folders + "new" entry
 *  - edit form: name / type rule / included threads / delete
 * Opened via PopupType.FOLDER_EDITOR; persists through FolderService (localStorage).
 */
@Component({
  selector: 'app-folder-editor',
  imports: [FormsModule, MatButtonModule, IconComponent, FitDialogDirective, TranslocoPipe],
  templateUrl: './folder-editor.component.html',
  styleUrl: './folder-editor.component.scss'
})
export class FolderEditorComponent implements OnInit {
  private readonly routeService = inject(RouteService)
  private readonly folderService = inject(FolderService)
  private readonly convList = inject(ConversationListService)
  private readonly transloco = inject(TranslocoService)
  private readonly language = inject(LanguageService)

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
  readonly statusFilter = signal<FolderStatusFilter>('NONE')
  readonly includedIds = signal<number[]>([])
  /** The full conversation set (the delta-replay list) — the picker's source. Reactive: populated when the
   *  HELLO-driven list lands, no fetch here. */
  readonly threadOptions = this.convList.items

  /** id of the folder being edited; undefined when creating */
  private editingExistingId: string | undefined

  readonly folders = computed(() => this.folderService.folders())

  /** Type-rule options. `key` is a translation key resolved in the template so the labels follow the
   *  active language; `summary()` reuses the same keys for the list rows. */
  readonly typeOptions: ReadonlyArray<{ value: FolderTypeFilter; key: string }> = [
    { value: 'ALL', key: 'folder.type.all' },
    { value: 'P2P', key: 'folder.type.direct' },
    { value: 'GROUP', key: 'folder.type.group' },
  ]

  /** Status-rule options; mirrors typeOptions. `key` is resolved in the template. */
  readonly statusOptions: ReadonlyArray<{ value: FolderStatusFilter; key: string }> = [
    { value: 'NONE', key: 'folder.status.none' },
    { value: 'UNREAD', key: 'folder.status.unread' },
  ]

  ngOnInit() {
    // threadOptions is the live conversation-list signal (no fetch) — open straight onto a folder when
    // invoked with its id.
    if (this.folderId()) {
      const f = this.folderService.getById(this.folderId()!)
      if (f) this.beginEdit(f)
    }
  }

  /** One-line summary for a folder row: localized type rule (+ selected count when chats are pinned).
   *  Reads the language signal so it re-evaluates on a language switch. */
  summary(f: ChatFolder): string {
    this.language.lang()
    const typeKey = f.typeFilter === 'ALL' ? 'folder.type.all' : f.typeFilter === 'P2P' ? 'folder.type.direct' : 'folder.type.group'
    const parts = [this.transloco.translate(typeKey)]
    if (f.statusFilter === 'UNREAD') parts.push(this.transloco.translate('folder.status.unread'))
    const t = parts.join(' · ')
    return f.includedIds.length
      ? `${t} · ${this.transloco.translate('folder.selected', { count: f.includedIds.length })}`
      : t
  }

  threadLabel(t: ConversationItem): string {
    return t.type === 'P2P' ? (t.peerUser?.account ?? '') : (t.group?.name ?? '')
  }

  beginCreate() {
    this.editingExistingId = undefined
    this.isEditingExisting.set(false)
    this.name.set('')
    this.typeFilter.set('ALL')
    this.statusFilter.set('NONE')
    this.includedIds.set([])
    this.editing.set(true)
  }

  beginEdit(f: ChatFolder) {
    this.editingExistingId = f.id
    this.isEditingExisting.set(true)
    this.name.set(f.name)
    this.typeFilter.set(f.typeFilter)
    this.statusFilter.set(f.statusFilter)
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
    const payload = { name, typeFilter: this.typeFilter(), statusFilter: this.statusFilter(), includedIds: this.includedIds() }
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
