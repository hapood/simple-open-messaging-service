import { Component, EventEmitter, Output, signal, computed, inject, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { ThreadListComponent } from '../../thread-list/thread-list.component';
import { ConversationItem } from '../../../services/model';
import { FolderService, ChatFolder } from '../../../services/folder.service';
import { AppIconType, IconComponent } from '../../icon/icon.component';

/**
 * Conversation pane: search + optional folder tabs + the shared thread list.
 * The folder tab bar renders ONLY once the user has at least one folder — mirroring
 * Telegram, which shows no tabs by default. Folder create/edit lives in icon-rail.
 */
@Component({
  selector: 'app-chat-list-pane',
  imports: [
    ThreadListComponent,
    FormsModule,
    TranslocoPipe,
    IconComponent,
  ],
  template: `
    <div class="chat-list-pane">
      <div class="search">
        <app-icon class="search-icon" [type]="AppIconType.SEARCH"
          [style]="{ width: '18px', height: '18px' }" />
        <input type="text" [placeholder]="'chat.searchPlaceholder' | transloco"
          [attr.aria-label]="'common.search' | transloco"
          [ngModel]="searchText()" (ngModelChange)="searchText.set($event)"
          (keydown.escape)="clearSearch($event)" />
        @if (searchText()) {
          <button class="clear-search" (click)="clearSearch()"
            [attr.aria-label]="'chat.clearSearch' | transloco">
            <app-icon [type]="AppIconType.CLOSE" [style]="{ width: '16px', height: '16px' }" />
          </button>
        }
      </div>
      @if (folders().length) {
        <div class="folder-tabs">
          <button class="ftab" [class.active]="!activeFolder()"
            (click)="activeFolderId.set(undefined)">{{ 'chat.all' | transloco }}</button>
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
      box-sizing: border-box;
      overflow: hidden;
      /* No border-right here: the inter-pane divider is owned by the shell, not the pane. On desktop the
         .resizer strip is the divider; on tablet the shell paints .drawer-body's border-right. Painting
         it here doubled the desktop divider (this 1px + the 4px resizer) and offset the grip dots 0.5px
         from the composite strip's center — which is why the dots read as crooked. */
    }
    .clear-search {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border: 0;
      cursor: pointer;
    }
    .clear-search:focus-visible {
      outline: 2px solid var(--app-focus-ring);
      outline-offset: 2px;
    }
    .search {
      position: relative;
      padding: 8px 10px 10px;
      box-sizing: border-box;
    }
    .search-icon {
      position: absolute;
      left: 22px;
      top: 16px;
      display: inline-flex;
      color: var(--app-text-muted);
      pointer-events: none;
    }
    .search input {
      width: 100%;
      box-sizing: border-box;
      height: 34px;
      padding: 0 38px 0 38px;
      border-radius: var(--app-radius-md);
      border: 1px solid var(--app-border-strong);
      background: var(--app-bg-muted);
      color: var(--app-text);
      font-size: 14px;
      outline: none;
      &::placeholder { color: var(--app-text-faint); }
      &:focus { border-color: var(--app-brand); }
    }
    .clear-search {
      position: absolute;
      right: 16px;
      top: 13px;
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: var(--app-radius-pill);
      color: var(--app-text-muted);
      background: transparent;
    }
    .clear-search:hover { background: var(--app-hover); color: var(--app-text); }
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

  readonly AppIconType = AppIconType
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

  clearSearch(event?: Event) {
    event?.preventDefault()
    this.searchText.set('')
  }

}
