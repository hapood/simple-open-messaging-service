import { Component, computed, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { MessageThreadComponent } from '../../message-thread/friend-message.component';
import { ChatEmptyComponent } from '../../chat-empty/chat-empty.component';
import { ConversationListService } from '../../../services/conversation-list.service';
import { ConversationItem } from '../../../services/model';

/**
 * Always-mounted shell chrome for the open chat. Renders against `ConversationListService.openThreadId`,
 * which the home shell syncs from the `chat/:threadId` URL — lagging the close on mobile so the *real* chat
 * slides out before its kernel resets (the empty placeholder never slides). Resolves the ConversationItem
 * from the shared list; a deep-link / just-joined thread that isn't in the list yet triggers one reload so it
 * resolves; a thread that vanishes while open (external SSE kick / leave, or an invalid deep-link) returns the
 * user to the conversation list rather than spinning on a reload.
 *
 * Unlike the old routed version this component is NOT created/destroyed on navigation — it persists for the
 * session (the shell lazy-mounts it via `@defer` on first open). mark-read + active-row highlight are owned by
 * the shell (it controls openThreadId's timing); this component is purely a view over it.
 */
@Component({
  selector: 'app-chat-pane',
  imports: [MessageThreadComponent, ChatEmptyComponent, TranslocoPipe],
  template: `
    <div class="chat-pane">
      @if (userMsgTrd(); as trd) {
        <app-message-thread [threadId]="trd.threadId" [userMsgTrd]="trd" />
      } @else if (openThreadId()) {
        <div class="loading">{{ 'chat.loading' | transloco }}</div>
      } @else {
        <app-chat-empty />
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
    .chat-pane > app-chat-empty { display: block; flex: 1 1 auto; min-height: 0; }
    .loading { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--app-text-faint); }
  `],
})
export class ChatPaneComponent {
  private readonly convList = inject(ConversationListService);
  private readonly router = inject(Router);

  /** The thread the shell has marked open. Lagged on mobile close so the chat slides out before its data resets. */
  readonly openThreadId = this.convList.openThreadId;

  /** Resolves the ConversationItem from the shared list; undefined while a deep-link/join is loading. */
  readonly userMsgTrd = computed<ConversationItem | undefined>(() => {
    const id = this.openThreadId();
    return id !== undefined ? this.convList.items().find((t) => t.threadId === id) : undefined;
  });

  /**
   * For each open thread we trigger at most ONE list reload when it's missing — so a deep-link / just-joined
   * thread resolves, but a genuinely-absent thread (invalid id, or removed by an external event) doesn't spin
   * the reload forever. Reset whenever the id changes.
   */
  private loadAttemptedFor: number | undefined;

  constructor() {
    effect(() => {
      const id = this.openThreadId();
      if (id === undefined) { this.loadAttemptedFor = undefined; return; }
      const present = this.convList.items().some((t) => t.threadId === id);
      if (present) { this.loadAttemptedFor = id; return; }
      if (this.convList.status() !== 'READY') return; // a load is in flight — wait for it
      if (this.loadAttemptedFor !== id) {
        // first miss while READY → fetch once (deep-link / just-joined)
        this.loadAttemptedFor = id;
        this.convList.load();
      } else {
        // already reloaded and still missing → the thread is gone (kick / leave / unfriend / bad link)
        this.router.navigate(['/']);
      }
    });
  }
}
