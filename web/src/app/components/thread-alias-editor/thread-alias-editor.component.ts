import {
  Component,
  computed,
  inject,
  input,
  signal,
  ChangeDetectionStrategy,
  ElementRef,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatCardModule } from '@angular/material/card';
import { MatInputModule } from '@angular/material/input';
import { MsgService } from '../../services/message.service';
import { ConversationListService } from '../../services/conversation-list.service';
import { AppIconType, IconComponent } from '../icon/icon.component';

/**
 * Inline alias/remark editor for a conversation, embedded in the peer-profile + group-info panels.
 * Shows the caller's current alias for the thread (or an "add remark" affordance); tapping toggles an
 * same-height input + Done action. Done, Enter, or blur hits `thread/set-alias` and patches the conv list
 * optimistically so the chat
 * header + conversation list update the displayed name immediately; the state delta re-confirms it
 * on the caller's other devices. An empty submit clears the alias (real name shows again).
 *
 * Rendered as a Material-style info card (WhatsApp/Telegram contact-detail rows): a leading tag icon +
 * a label on the left and value/action on the right, contained in a rounded surface card that is centered
 * and width-capped. Edit mode reuses the exact same row height.
 *
 * Per-user only: setting an alias for a peer/group is the CALLER's private label — the peer never sees it
 * and (for groups) other members' view of the group name is unaffected.
 */
@Component({
  selector: 'app-thread-alias-editor',
  imports: [
    FormsModule,
    TranslocoPipe,
    MatCardModule,
    MatInputModule,
    IconComponent,
  ],
  template: `
    <div class="alias-editor">
      <mat-card appearance="outlined" class="alias-card">
        <span class="alias-heading">
          <span class="alias-icon" aria-hidden="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"
              />
              <line x1="7" y1="7" x2="7.01" y2="7" />
            </svg>
          </span>
          <span class="field-label">{{ 'chat.alias' | transloco }}</span>
        </span>
        <span class="alias-control">
          @if (editing()) {
            <input
              matInput
              class="alias-input"
              #aliasInput
              type="text"
              maxlength="64"
              [placeholder]="'chat.aliasAdd' | transloco"
              [ngModel]="draft()"
              (ngModelChange)="draft.set($event)"
              (keyup.enter)="save()"
              (keyup.escape)="cancel()"
              (blur)="save()"
            />
            <button
              class="edit-button done"
              type="button"
              (mousedown)="$event.preventDefault()"
              (click)="save()"
              [attr.aria-label]="'common.done' | transloco"
            >
              <app-icon
                [type]="AppIconType.CHECK"
                [style]="{ width: '18px', height: '18px' }"
              />
            </button>
          } @else {
            <span class="alias-value" [class.placeholder]="!currentAlias()">
              {{ currentAlias() || ('chat.aliasAdd' | transloco) }}
            </span>
            <button
              class="edit-button"
              type="button"
              (click)="start()"
              [attr.aria-label]="'common.edit' | transloco"
            >
              <app-icon
                [type]="AppIconType.EDIT"
                [style]="{ width: '18px', height: '18px' }"
              />
            </button>
          }
        </span>
      </mat-card>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .alias-editor {
        width: 100%;
        display: flex;
        justify-content: center;
        padding-inline: var(
          --app-space-4
        ); /* 16px inset so the card never kisses the panel edge */
        box-sizing: border-box;
      }

      // ── Material info card: rounded, elevated surface; centered + width-capped so the row no longer
      //    spans the full panel width (WhatsApp/Telegram contact-detail field card). ──
      .alias-card {
        width: 100%;
        max-width: 420px;
        height: 64px;
        overflow: hidden;
        display: flex;
        flex-direction: row;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        padding: 0 12px 0 16px;
        box-sizing: border-box;
      }
      .alias-heading {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 10px;
      }
      .alias-icon {
        flex: 0 0 auto;
        display: inline-flex;
        color: var(--app-text-muted);
      }
      .alias-control {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 6px;
      }
      .field-label {
        font-size: 14px;
        line-height: 20px;
        color: var(--app-text-muted);
      }
      .alias-value {
        font-size: 15px;
        line-height: 20px;
        color: var(--app-text);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .alias-value.placeholder {
        color: var(--app-text-faint);
      }

      .alias-input {
        width: min(100%, 220px);
        min-width: 0;
        height: 36px;
        padding: 0 8px;
        border: 1px solid var(--app-border-strong);
        border-radius: var(--app-radius-sm);
        background: var(--app-surface);
        color: var(--app-text);
        font-size: 15px;
        line-height: 20px;
        box-sizing: border-box;
        outline: none;
        transition:
          border-color 0.12s,
          box-shadow 0.12s;
      }
      .alias-input:focus {
        border-color: var(--app-brand);
        box-shadow: 0 0 0 1px var(--app-brand);
      }
      .edit-button {
        flex: 0 0 32px;
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0;
        border: 0;
        border-radius: var(--app-radius-sm);
        background: transparent;
        color: var(--app-text-muted);
        cursor: pointer;
      }
      .edit-button:hover,
      .edit-button:focus-visible {
        color: var(--app-brand);
        background: var(--app-hover);
      }
      .edit-button.done {
        color: var(--app-brand);
      }
    `,
  ],
})
export class ThreadAliasEditorComponent {
  readonly AppIconType = AppIconType;
  readonly threadId = input.required<number>();

  private readonly msgService = inject(MsgService);
  private readonly convList = inject(ConversationListService);

  /** The live alias from the conversation list, including changes synced from another device. */
  readonly currentAlias = computed(() => {
    const t = this.convList
      .items()
      .find((it) => it.threadId === this.threadId());
    return t?.alias ?? '';
  });

  readonly editing = signal(false);
  readonly draft = signal('');
  private readonly aliasInput =
    viewChild<ElementRef<HTMLInputElement>>('aliasInput');

  start(): void {
    this.draft.set(this.currentAlias());
    this.editing.set(true);
    requestAnimationFrame(() => this.aliasInput()?.nativeElement.focus());
  }
  cancel(): void {
    this.editing.set(false);
    this.draft.set('');
  }
  save(): void {
    if (!this.editing()) return;
    const next = this.draft().trim();
    const tid = this.threadId();
    const previous = this.currentAlias();
    // Optimistic patch so the header/list title flips instantly; the state delta re-confirms it.
    this.convList.applyThreadMeta(tid, {
      alias: next.length > 0 ? next : null,
    });
    this.msgService.setAlias({ threadId: tid, alias: next }).subscribe({
      error: () =>
        this.convList.applyThreadMeta(tid, { alias: previous || null }), // revert on failure
    });
    this.editing.set(false);
    this.draft.set('');
  }
}
