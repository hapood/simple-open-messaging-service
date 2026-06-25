import { Component, EventEmitter, Output, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ThreadListComponent, ThreadFilterType } from '../../thread-list/thread-list.component';
import { UserMessageThread } from '../../../services/model';

/**
 * Desktop middle pane: search + type-filter tabs + the shared thread list.
 * Owns the search/filter UI state; delegates rendering + data to thread-list.
 */
@Component({
  selector: 'app-chat-list-pane',
  imports: [ThreadListComponent, FormsModule],
  template: `
    <div class="chat-list-pane">
      <div class="search">
        <input type="text" placeholder="搜索"
          [ngModel]="searchText()" (ngModelChange)="searchText.set($event)" />
      </div>
      <div class="tabs">
        @for (tab of tabs; track tab.value) {
          <button class="tab" [class.active]="filterType() === tab.value"
            (click)="filterType.set(tab.value)">{{ tab.label }}</button>
        }
      </div>
      <div class="list">
        <app-thread-list
          [filterType]="filterType()"
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
      background: #fff;
      border-right: 1px solid #e5e7eb;
      box-sizing: border-box;
      overflow: hidden;
    }
    .search { padding: 10px; box-sizing: border-box; }
    .search input {
      width: 100%;
      box-sizing: border-box;
      height: 34px;
      padding: 0 10px;
      border-radius: 8px;
      border: 1px solid #d1d5db;
      font-size: 14px;
      outline: none;
    }
    .tabs { display: flex; gap: 6px; padding: 0 10px 8px; }
    .tab {
      flex: 1;
      height: 30px;
      border: 1px solid #d1d5db;
      background: #fff;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      color: #374151;
    }
    .tab.active { background: #2563eb; border-color: #2563eb; color: #fff; }
    .list { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  `]
})
export class ChatListPaneComponent {
  readonly tabs: ReadonlyArray<{ value: ThreadFilterType, label: string }> = [
    { value: 'ALL', label: '全部' },
    { value: 'P2P', label: '个人' },
    { value: 'GROUP', label: '群组' },
  ]
  readonly filterType = signal<ThreadFilterType>('ALL')
  readonly searchText = signal('')
  readonly threadListCmp = viewChild(ThreadListComponent)

  @Output() selectThread = new EventEmitter<UserMessageThread>()

  refresh() {
    this.threadListCmp()?.genThreadList()
  }
}
