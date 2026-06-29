import { Component, input } from '@angular/core';
import { MessageThreadComponent } from '../../message-thread/friend-message.component';
import { BrandLogoComponent } from '../../brand-logo/brand-logo.component';
import { UserMessageThread } from '../../../services/model';

/**
 * Desktop right pane: renders the selected thread INLINE (not as a popup) via
 * the shared message-thread, or a WhatsApp-style branded placeholder when
 * nothing is selected. message-thread fills this pane thanks to its fill-parent chain.
 */
@Component({
  selector: 'app-chat-pane',
  imports: [MessageThreadComponent, BrandLogoComponent],
  template: `
    <div class="chat-pane">
      @if (userMsgTrd(); as trd) {
        <app-message-thread [userThreadId]="trd.id" [userMsgTrd]="trd" />
      } @else {
        <div class="empty">
          <div class="empty-main">
            <app-brand-logo [size]="72" tagline="选择一个会话，开始你的对话" />
          </div>
          <div class="empty-foot">
            <svg class="lock" width="12" height="12" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="11" width="18" height="11" rx="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <span>你的消息在传输中受到端到端保护。SOMS 无法读取。</span>
          </div>
        </div>
      }
    </div>
  `,
  styles: [`
    .chat-pane {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: var(--app-surface);
      overflow: hidden;
    }
    .empty {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 48px 24px;
      box-sizing: border-box;
    }
    .empty-main {
      flex: 1;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
    }
    .empty-foot {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: var(--app-text-faint);
      font-size: 12px;
      text-align: center;
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
