import { Component, input } from '@angular/core';
import { MessageThreadComponent } from '../../message-thread/friend-message.component';
import { UserMessageThread } from '../../../services/model';

/**
 * Desktop right pane: renders the selected thread INLINE (not as a popup) via
 * the shared message-thread, or an empty-state placeholder when nothing is
 * selected. message-thread fills this pane thanks to its fill-parent chain.
 */
@Component({
  selector: 'app-chat-pane',
  imports: [MessageThreadComponent],
  template: `
    <div class="chat-pane">
      @if (userMsgTrd(); as trd) {
        <app-message-thread [userThreadId]="trd.id" [userMsgTrd]="trd" />
      } @else {
        <div class="empty">选择一个会话开始聊天</div>
      }
    </div>
  `,
  styles: [`
    .chat-pane {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: #fff;
      overflow: hidden;
    }
    .empty {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #9ca3af;
      font-size: 15px;
    }
    .chat-pane > app-message-thread {
      display: block;
      flex: 1 1 auto;
      min-height: 0;
    }
  `]
})
export class ChatPaneComponent {
  readonly userMsgTrd = input<UserMessageThread>()
}
