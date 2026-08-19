import {
  Component,
  computed,
  input,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';

/** Authoritative terminal call record stored as JSON in Message.content. */
interface CallContent {
  type: 'CALL';
  callType: 'AUDIO' | 'VIDEO';
  status:
    | 'completed'
    | 'cancelled'
    | 'declined'
    | 'missed'
    | 'failed'
    | 'unreachable';
  callerId: number;
  calleeId: number;
  startedAt?: number;
  endedAt?: number;
  durationMs?: number;
}

/**
 * Terminal 1:1 call record. It follows the same row/group/avatar contract as the other message cards, while
 * the inset icon tile and two-level typography make calls easy to scan in a busy conversation.
 */
@Component({
  selector: 'app-msg-call-row',
  standalone: true,
  imports: [DateRowComponent, UserAvatarComponent, TranslocoPipe],
  templateUrl: './call-row.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './call-row.component.scss',
})
export class CallRowComponent {
  readonly UserAvatarType = UserAvatarType;
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input<boolean>(false);

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(
    () =>
      this.isShowHead() &&
      this.data().isGroupConversation === true &&
      !this.data().isSelf,
  );

  private readonly content = computed<CallContent | null>(() => {
    try {
      const value = JSON.parse(this.data().text) as Partial<CallContent>;
      return value.type === 'CALL' ? (value as CallContent) : null;
    } catch {
      return null;
    }
  });

  readonly isVideo = computed(() => this.content()?.callType === 'VIDEO');
  readonly isAlert = computed(() => {
    const status = this.content()?.status;
    return (
      status === 'missed' || status === 'failed' || status === 'unreachable'
    );
  });

  readonly titleKey = computed(() =>
    this.isVideo() ? 'call.videoCall' : 'call.audioCall',
  );

  /** Direction- and result-aware secondary label. */
  readonly statusKey = computed(() => {
    const status = this.content()?.status;
    const self = this.data().isSelf;
    switch (status) {
      case 'missed':
        return self ? 'call.record.cancelled' : 'call.record.missed';
      case 'failed':
        return 'call.record.failed';
      case 'unreachable':
        return 'call.record.unreachable';
      case 'declined':
        return 'call.record.declined';
      case 'cancelled':
        return 'call.record.cancelled';
      case 'completed':
        return self ? 'call.record.outgoing' : 'call.record.incoming';
      default:
        return 'call.record.unknown';
    }
  });

  /** Connected duration as m:ss or h:mm:ss; absent for calls that never connected. */
  readonly duration = computed(() => {
    const ms = this.content()?.durationMs;
    if (!ms || ms < 1000) return '';
    const totalSeconds = Math.floor(ms / 1000);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}:${seconds}`;
    const hours = Math.floor(totalMinutes / 60);
    return `${hours}:${String(totalMinutes % 60).padStart(2, '0')}:${seconds}`;
  });
}
