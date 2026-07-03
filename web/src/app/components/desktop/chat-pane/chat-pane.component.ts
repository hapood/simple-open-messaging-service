import { Component, computed, effect, inject, input, OnDestroy } from '@angular/core';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { MessageThreadComponent } from '../../message-thread/friend-message.component';
import { ConversationListService } from '../../../services/conversation-list.service';
import { ConversationItem } from '../../../services/model';

/**
 * Route component for the open chat (`chat/:threadId`). `threadId` is bound from the route param via
 * withComponentInputBinding. The ConversationItem is resolved from the shared list — the route owns
 * "which chat is open", so this component also drives mark-read + active-row highlight (convList.open on
 * activate/switch, convList.close on teardown). A deep-link / just-joined thread that isn't in the list
 * yet triggers one reload so it resolves; a thread that vanishes while open (external SSE kick/leave, or
 * an invalid deep-link) returns the user to the conversation list rather than spinning on a reload.
 */
@Component({
  selector: 'app-chat-pane',
  imports: [MessageThreadComponent, TranslocoPipe],
  template: `
    <div class="chat-pane">
      @if (userMsgTrd(); as trd) {
        <app-message-thread [threadId]="trd.threadId" [userMsgTrd]="trd" />
      } @else {
        <div class="loading">{{ 'chat.loading' | transloco }}</div>
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
    .loading { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--app-text-faint); }
  `],
})
export class ChatPaneComponent implements OnDestroy {
  /** Bound from the `:threadId` route param (withComponentInputBinding). */
  readonly threadId = input<number>()
  private readonly convList = inject(ConversationListService)
  private readonly router = inject(Router)

  /**
   * Numeric thread id, coerced from the route param. `withComponentInputBinding` delivers path params
   * as STRINGS — the router performs no type coercion, so `threadId` above actually receives e.g.
   * "123" despite its `number` type. Coerce once at this boundary: a stray string would otherwise
   * (a) never `===` the numeric `ConversationItem.threadId`, so the thread never resolves and the
   * missing-thread effect bails to the empty state, and (b) reach `convList.open` → `markRead`, where
   * the backend `ThreadAccessGuard` reads the raw body (before ValidationPipe transforms it) and hands
   * Prisma's Int field a string → PrismaClientValidationError → HTTP 500.
   */
  readonly threadIdNum = computed<number | undefined>(() => {
    const raw = this.threadId()
    if (raw === undefined) return undefined
    const n = typeof raw === 'number' ? raw : Number(raw)
    return Number.isFinite(n) ? n : undefined
  })

  /** Resolves the ConversationItem from the shared list; undefined while a deep-link/join is loading. */
  readonly userMsgTrd = computed<ConversationItem | undefined>(() => {
    const id = this.threadIdNum()
    return id !== undefined ? this.convList.items().find((t) => t.threadId === id) : undefined
  })

  /**
   * For each threadId we trigger at most ONE list reload when it's missing — so a deep-link / just-joined
   * thread resolves, but a genuinely-absent thread (invalid id, or removed by an external event) doesn't
   * spin the reload forever. Reset whenever the id changes.
   */
  private loadAttemptedFor: number | undefined

  constructor() {
    // mark-read + active-row highlight follow the open chat; re-runs on chat switch (param change).
    effect(() => {
      const id = this.threadIdNum()
      if (id !== undefined) this.convList.open(id)
    })

    effect(() => {
      const id = this.threadIdNum()
      if (id === undefined) { this.loadAttemptedFor = undefined; return }
      const present = this.convList.items().some((t) => t.threadId === id)
      if (present) { this.loadAttemptedFor = id; return }
      if (this.convList.status() !== 'READY') return // a load is in flight — wait for it
      if (this.loadAttemptedFor !== id) {
        // first miss while READY → fetch once (deep-link / just-joined)
        this.loadAttemptedFor = id
        this.convList.load()
      } else {
        // already reloaded and still missing → the thread is gone (kick / leave / unfriend / bad link)
        this.router.navigate(['/'])
      }
    })
  }

  ngOnDestroy(): void {
    // leaving the chat route clears "currently viewing" so incoming messages re-arm the unread badge
    this.convList.close()
  }
}
