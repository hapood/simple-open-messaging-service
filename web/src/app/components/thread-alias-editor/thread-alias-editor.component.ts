import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MsgService } from '../../services/message.service';
import { ConversationListService } from '../../services/conversation-list.service';

/**
 * Inline alias/remark (备注) editor for a conversation, embedded in the peer-profile + group-info panels.
 * Shows the caller's current alias for the thread (or an "add remark" affordance); tapping toggles an
 * input + Save/Cancel. Save hits `thread/set-alias` and patches the conv list optimistically so the chat
 * header + conversation list update the displayed name immediately; the THREAD_META frame re-confirms it
 * on the caller's other devices. An empty submit clears the alias (real name shows again).
 *
 * Per-user only: setting an alias for a peer/group is the CALLER's private label — the peer never sees it
 * and (for groups) other members' view of the group name is unaffected.
 */
@Component({
  selector: 'app-thread-alias-editor',
  imports: [FormsModule, TranslocoPipe, MatButtonModule],
  template: `
    <div class="alias-editor">
      @if (editing()) {
        <input
          #i
          class="alias-input"
          type="text"
          maxlength="64"
          [placeholder]="'chat.aliasPlaceholder' | transloco"
          [ngModel]="draft()"
          (ngModelChange)="draft.set($event)"
          (keyup.enter)="save()"
          (keyup.escape)="cancel()"
        />
        <div class="alias-actions">
          <button mat-stroked-button (click)="cancel()">{{ 'common.cancel' | transloco }}</button>
          <button mat-raised-button color="primary" (click)="save()">{{ 'common.save' | transloco }}</button>
        </div>
      } @else {
        <button class="alias-row" type="button" (click)="start()">
          <span class="alias-label">{{ 'chat.alias' | transloco }}</span>
          <span class="alias-value" [class.placeholder]="!currentAlias()">
            {{ currentAlias() || ('chat.aliasAdd' | transloco) }}
          </span>
        </button>
      }
    </div>
  `,
  styles: [`
    .alias-editor { width: 100%; }
    .alias-row {
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      width: 100%; height: 44px; padding: 0 4px;
      border: none; background: transparent; cursor: pointer; text-align: left;
      font: inherit; color: var(--app-text); box-sizing: border-box;
    }
    .alias-row:hover { background: var(--app-hover); }
    .alias-label { font-size: 14px; color: var(--app-text-soft, var(--app-text)); opacity: 0.8; }
    .alias-value {
      font-size: 14px; max-width: 60%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .alias-value.placeholder { color: var(--app-text-faint, var(--app-text)); opacity: 0.6; }
    .alias-input {
      width: 100%; height: 36px; padding: 0 10px;
      border: 1px solid var(--app-border); border-radius: var(--app-radius-sm, 8px);
      background: var(--app-bg, transparent); color: var(--app-text);
      font-size: 14px; line-height: 20px; box-sizing: border-box; outline: none;
    }
    .alias-input:focus { border-color: var(--app-brand); }
    .alias-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 8px; }
  `],
})
export class ThreadAliasEditorComponent {
  readonly threadId = input.required<number>()

  private readonly msgService = inject(MsgService)
  private readonly convList = inject(ConversationListService)

  /** The live alias from the conv list (so a THREAD_META from another device updates it in place). */
  readonly currentAlias = computed(() => {
    const t = this.convList.items().find((it) => it.threadId === this.threadId())
    return t?.alias ?? ''
  })

  readonly editing = signal(false)
  readonly draft = signal('')

  start(): void {
    this.draft.set(this.currentAlias())
    this.editing.set(true)
  }
  cancel(): void {
    this.editing.set(false)
    this.draft.set('')
  }
  save(): void {
    const next = this.draft().trim()
    const tid = this.threadId()
    // Optimistic patch so the header/list title flips instantly; the THREAD_META echo re-confirms it.
    this.convList.applyThreadMeta(tid, { alias: next.length > 0 ? next : null })
    this.msgService.setAlias({ threadId: tid, alias: next }).subscribe({
      error: () => this.convList.applyThreadMeta(tid, { alias: this.currentAlias() }), // revert on failure
    })
    this.editing.set(false)
    this.draft.set('')
  }
}
