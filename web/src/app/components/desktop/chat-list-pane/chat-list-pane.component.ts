import { Component, EventEmitter, Output, signal, viewChild } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { ThreadListComponent } from '../../thread-list/thread-list.component';
import { ConversationItem } from '../../../services/model';
import { ThreadSearchInputComponent } from '../../thread-search-input/thread-search-input.component';

/**
 * Conversation pane: search + the shared thread list.
 */
@Component({
  selector: 'app-chat-list-pane',
  imports: [
    ThreadListComponent,
    TranslocoPipe,
    ThreadSearchInputComponent,
  ],
  template: `
    <div class="chat-list-pane">
      <app-thread-search-input
        [value]="searchText()"
        [placeholder]="'chat.searchPlaceholder' | transloco"
        [ariaLabel]="'common.search' | transloco"
        [clearAriaLabel]="'chat.clearSearch' | transloco"
        (valueChange)="searchText.set($event)"
      />
      <div class="list">
        <app-thread-list
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
      background: var(--app-thread-list-bg);
      box-sizing: border-box;
      overflow: hidden;
      /* No border-right here: the inter-pane divider is owned by the shell, not the pane. On desktop the
         .resizer strip is the divider; on tablet the shell paints .drawer-body's border-right. Painting
         it here doubled the desktop divider (this 1px + the 4px resizer) and offset the grip dots 0.5px
         from the composite strip's center — which is why the dots read as crooked. */
    }
    .list { flex: 1 1 auto; min-height: 0; overflow-y: auto; }
  `]
})
export class ChatListPaneComponent {
  readonly searchText = signal('')
  readonly threadListCmp = viewChild(ThreadListComponent)

  @Output() selectThread = new EventEmitter<ConversationItem>()

  refresh() {
    this.threadListCmp()?.genThreadList()
  }

}
