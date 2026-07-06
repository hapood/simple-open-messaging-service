import { Component, input } from '@angular/core';
import { MessageThreadComponent } from '../message-thread/friend-message.component';
import type { ConversationItem } from '../../services/model';

/**
 * Thin wrapper around {@link MessageThreadComponent} used by the join hero-transition overlay. It
 * replicates the ChatPane shell (`.chat-pane` flex column + surface background) so the message
 * thread has identical layout/sizing to the real chat-slot while it animates in (circle-expand).
 *
 * Input-driven (`threadId` + `userMsgTrd`) rather than reading the global `ConversationListService.
 * openThreadId` like the routed {@link ChatPaneComponent} — a ComponentPortal mounts it
 * imperatively for a SPECIFIC thread so the overlay shows the joining group, not whichever thread
 * happens to be open.
 */
@Component({
  selector: 'app-chat-transition-host',
  imports: [MessageThreadComponent],
  template: `
    <div class="chat-pane">
      @if (userMsgTrd(); as trd) {
        <app-message-thread [threadId]="threadId()" [userMsgTrd]="trd" />
      }
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .chat-pane {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
      background: var(--app-surface);
      overflow: hidden;
    }
    .chat-pane > app-message-thread { display: block; flex: 1 1 auto; min-height: 0; }
  `],
})
export class ChatTransitionHostComponent {
  readonly threadId = input<number>();
  readonly userMsgTrd = input<ConversationItem>();
}
