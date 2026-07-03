import { Component, EventEmitter, Output, signal, computed, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ThreadListComponent } from '../../thread-list/thread-list.component';
import { ConversationItem } from '../../../services/model';
import { FolderService, ChatFolder } from '../../../services/folder.service';

/**
 * Desktop middle pane: search + (optional) folder tabs + the shared thread list.
 * The folder tab bar renders ONLY once the user has at least one folder — mirroring
 * Telegram, which shows no tabs by default. Folder create/edit lives in icon-rail.
 */
@Component({
  selector: 'app-chat-list-pane',
  imports: [ThreadListComponent, FormsModule],
  template: `
    <div class="chat-list-pane">
      <div class="search">
        <input type="text" placeholder="Search"
          [ngModel]="searchText()" (ngModelChange)="searchText.set($event)" />
      </div>
      @if (folders().length) {
        <div class="folder-tabs">
          <button class="ftab" [class.active]="!activeFolder()"
            (click)="activeFolderId.set(undefined)">All</button>
          @for (f of folders(); track f.id) {
            <button class="ftab" [class.active]="activeFolder()?.id === f.id"
              (click)="activeFolderId.set(f.id)">{{ f.name }}</button>
          }
        </div>
      }
      <div class="list">
        <app-thread-list
          [folder]="activeFolder()"
          [searchText]="searchText()"
          (onSelect)="selectThread.emit($event)">
        </app-thread-list>
      </div>
    </div>
  `,
  styles: [`
    .chat-list-pane {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--app-surface);
      border-right: 1px solid var(--app-border);
      box-sizing: border-box;
      overflow: hidden;
    }
    .search { padding: 10px; box-sizing: border-box; }
    .search input {
      width: 100%;
      box-sizing: border-box;
      height: 34px;
      padding: 0 10px;
      border-radius: var(--app-radius-md);
      border: 1px solid var(--app-border-strong);
      background: var(--app-bg-muted);
      color: var(--app-text);
      font-size: 14px;
      outline: none;
      &::placeholder { color: var(--app-text-faint); }
      &:focus { border-color: var(--app-brand); }
    }
    .folder-tabs {
      display: flex;
      gap: 6px;
      padding: 0 10px 8px;
      overflow-x: auto;
      scrollbar-width: thin;
    }
    .ftab {
      flex: 0 0 auto;
      height: 30px;
      padding: 0 14px;
      border: 1px solid var(--app-border-strong);
      background: var(--app-surface);
      border-radius: var(--app-radius-pill);
      cursor: pointer;
      font-size: 13px;
      color: var(--app-text);
      white-space: nowrap;
    }
    .ftab.active { background: var(--app-brand); border-color: var(--app-brand); color: #fff; }
    .list { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  `]
})
export class ChatListPaneComponent {
  private readonly folderService = inject(FolderService)

  /** undefined = "All" (no folder filter) */
  readonly activeFolderId = signal<string | undefined>(undefined)
  readonly searchText = signal('')
  readonly threadListCmp = viewChild(ThreadListComponent)

  readonly folders = computed(() => this.folderService.folders())

  /** resolves the active folder (undefined for "All", or when its id was deleted) */
  readonly activeFolder = computed<ChatFolder | undefined>(() => {
    const id = this.activeFolderId()
    return id ? this.folderService.getById(id) : undefined
  })

  @Output() selectThread = new EventEmitter<ConversationItem>()

  refresh() {
    this.threadListCmp()?.genThreadList()
  }
}
