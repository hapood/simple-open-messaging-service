import { Component, computed, input } from '@angular/core';
import type { ChatMsgData } from '../chat-item';

/** The CALL message-bubble content (built authoritatively server-side by call-content.ts), stored as JSON in
 *  Message.content (= ChatMsgData.text here, like the LINK card). */
interface CallContent {
  type: 'CALL';
  callType: 'AUDIO' | 'VIDEO';
  status: 'completed' | 'cancelled' | 'declined' | 'missed' | 'failed' | 'unreachable';
  callerId: number;
  calleeId: number;
  /** Present iff the call connected (the real connect marker, NOT accept). */
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

/**
 * CALL message row — a terminal 1:1-call record rendered as a compact call-info bubble: a phone/video icon,
 * a direction- + status-aware label, and the duration (when the call connected). Direction is derived from
 * `data().isSelf` (creator === me → outgoing).
 *
 * Mirrors {@link LinkRowComponent}'s shape (parses `data().text` JSON via a computed so an in-place update
 * re-parses) but renders a much simpler call pill. The 4 signal inputs satisfy the shared RowComponent
 * interface (createMsgCbElement sets them); the call row ignores the grouping/date flags visually (a call
 * record is a self-contained note, not grouped like text). Hardcoded English labels for Phase 3; bilingual
 * i18n is a follow-up.
 */
@Component({
  selector: 'app-msg-call-row',
  standalone: true,
  template: `
    <div class="call-row" [class.self]="data().isSelf">
      <span class="icon">{{ icon() }}</span>
      <span class="label">{{ label() }}</span>
      @if (duration()) {
        <span class="dur">{{ duration() }}</span>
      }
    </div>
  `,
  styles: [
    `
      .call-row {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 8px 14px;
        border-radius: 14px;
        background: rgba(140, 140, 140, 0.16);
        font-size: 14px;
        line-height: 20px;
      }
      .icon {
        font-size: 16px;
        line-height: 20px;
      }
      .label {
        font-weight: 500;
      }
      .dur {
        opacity: 0.7;
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class CallRowComponent {
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  /** Whether a date-separator pill should render above this row (first message of its day). */
  readonly showDate = input<boolean>(false);

  /** The parsed call content, derived from `data().text` so an in-place update re-parses. */
  private readonly content = computed<CallContent | null>(() => {
    try {
      return JSON.parse(this.data().text) as CallContent;
    } catch {
      return null;
    }
  });

  readonly icon = computed(() => (this.content()?.callType === 'VIDEO' ? '🎥' : '📞'));

  /** Direction- + status-aware label (matches the conversation-list rawPreview markers). */
  readonly label = computed(() => {
    const c = this.content();
    const self = this.data().isSelf;
    switch (c?.status) {
      case 'missed':
        return self ? 'Cancelled' : 'Missed call';
      case 'failed':
        return 'Call failed';
      case 'unreachable':
        return 'Unreachable';
      case 'declined':
        return 'Declined';
      case 'cancelled':
        return 'Cancelled';
      default:
        return self ? 'Outgoing call' : 'Incoming call';
    }
  });

  /** The connected duration as m:ss (empty when the call never connected — missed/declined/cancelled). */
  readonly duration = computed(() => {
    const ms = this.content()?.durationMs;
    if (!ms) return '';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    return `${m}:${String(s % 60).padStart(2, '0')}`;
  });
}
