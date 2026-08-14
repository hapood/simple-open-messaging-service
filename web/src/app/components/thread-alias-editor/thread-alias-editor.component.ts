import { Component, computed, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import { MsgService } from '../../services/message.service';
import { ConversationListService } from '../../services/conversation-list.service';

/**
 * Inline alias/remark editor for a conversation, embedded in the peer-profile + group-info panels.
 * Shows the caller's current alias for the thread (or an "add remark" affordance); tapping toggles an
 * input + Save/Cancel. Save hits `thread/set-alias` and patches the conv list optimistically so the chat
 * header + conversation list update the displayed name immediately; the state delta re-confirms it
 * on the caller's other devices. An empty submit clears the alias (real name shows again).
 *
 * Rendered as a Material-style info card (WhatsApp/Telegram contact-detail rows): a leading tag icon +
 * a two-line label/value stack, contained in a rounded surface card that is centered and width-capped so
 * it no longer stretches edge-to-edge across the aside panel. Edit mode reuses the same card chrome.
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
        <div class="alias-card edit">
          <span class="field-label">{{ 'chat.alias' | transloco }}</span>
          <input
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
            <button mat-flat-button color="primary" (click)="save()">{{ 'common.save' | transloco }}</button>
          </div>
        </div>
      } @else {
        <div class="alias-card">
          <button class="alias-row" type="button" (click)="start()">
            <span class="alias-icon" aria-hidden="true">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z" />
                <line x1="7" y1="7" x2="7.01" y2="7" />
              </svg>
            </span>
            <span class="alias-text">
              <span class="field-label">{{ 'chat.alias' | transloco }}</span>
              <span class="alias-value" [class.placeholder]="!currentAlias()">
                {{ currentAlias() || ('chat.aliasAdd' | transloco) }}
              </span>
            </span>
          </button>
        </div>
      }
    </div>
  `,
  styles: [`
    .alias-editor {
      width: 100%;
      display: flex;
      justify-content: center;
      padding-inline: var(--app-space-4);   /* 16px inset so the card never kisses the panel edge */
      box-sizing: border-box;
    }

    // ── Material info card: rounded, elevated surface; centered + width-capped so the row no longer
    //    spans the full panel width (WhatsApp/Telegram contact-detail field card). ──
    .alias-card {
      width: 100%;
      max-width: 420px;
      background: var(--app-surface-elevated);
      border: 1px solid var(--app-border);
      border-radius: var(--app-radius-lg);
      box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
      overflow: hidden;
    }

    .alias-row {
      display: flex;
      align-items: center;
      gap: var(--app-space-4);
      width: 100%;
      padding: 12px 16px;
      box-sizing: border-box;
      border: none;
      background: transparent;
      cursor: pointer;
      text-align: left;
      font: inherit;
      color: var(--app-text);
      transition: background-color 0.12s;
    }
    .alias-row:hover { background: var(--app-hover); }

    .alias-icon { flex: 0 0 auto; display: inline-flex; color: var(--app-text-muted); }
    .alias-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .field-label { font-size: 12px; color: var(--app-text-muted); }
    .alias-value {
      font-size: 15px;
      color: var(--app-text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .alias-value.placeholder { color: var(--app-text-faint); }

    // ── Edit mode: same card chrome, with a label, outlined input, and right-aligned actions. ──
    .edit { padding: 14px 16px; }
    .edit .field-label { display: block; margin-bottom: 6px; }
    .alias-input {
      width: 100%;
      height: 40px;
      padding: 0 12px;
      border: 1px solid var(--app-border-strong);
      border-radius: var(--app-radius-sm);
      background: var(--app-surface);
      color: var(--app-text);
      font-size: 15px;
      line-height: 20px;
      box-sizing: border-box;
      outline: none;
      transition: border-color 0.12s, box-shadow 0.12s;
    }
    .alias-input:focus {
      border-color: var(--app-brand);
      box-shadow: 0 0 0 1px var(--app-brand);
    }
    .alias-actions {
      display: flex;
      gap: var(--app-space-2);
      justify-content: flex-end;
      margin-top: 10px;
    }
  `],
})
export class ThreadAliasEditorComponent {
  readonly threadId = input.required<number>()

  private readonly msgService = inject(MsgService)
  private readonly convList = inject(ConversationListService)

  /** The live alias from the conversation list, including changes synced from another device. */
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
    // Optimistic patch so the header/list title flips instantly; the state delta re-confirms it.
    this.convList.applyThreadMeta(tid, { alias: next.length > 0 ? next : null })
    this.msgService.setAlias({ threadId: tid, alias: next }).subscribe({
      error: () => this.convList.applyThreadMeta(tid, { alias: this.currentAlias() }), // revert on failure
    })
    this.editing.set(false)
    this.draft.set('')
  }
}
