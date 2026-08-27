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

  private readonly content = computed(() => {
    const content = this.data().callContent;
    if (!content) throw new Error('CALL row requires parsed callContent');
    return content;
  });

  readonly isVideo = computed(() => this.content().callType === 'VIDEO');
  readonly isAlert = computed(() => {
    const outcome = this.content().outcome;
    return (
      outcome === 'missed' || outcome === 'failed' || outcome === 'unreachable'
    );
  });

  readonly titleKey = computed(() =>
    this.isVideo() ? 'call.videoCall' : 'call.audioCall',
  );

  /** Direction- and result-aware primary label. */
  readonly statusKey = computed(() => {
    const outcome = this.content().outcome;
    const self = this.data().isSelf;
    switch (outcome) {
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
    const ms = this.content().durationMs;
    if (!ms || ms < 1000) return '';
    const totalSeconds = Math.floor(ms / 1000);
    const seconds = String(totalSeconds % 60).padStart(2, '0');
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60) return `${totalMinutes}:${seconds}`;
    const hours = Math.floor(totalMinutes / 60);
    return `${hours}:${String(totalMinutes % 60).padStart(2, '0')}:${seconds}`;
  });
}
