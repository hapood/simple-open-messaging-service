import { Component, computed, input, output } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { MatIconModule } from '@angular/material/icon';
import { MEDIA_STATUS, type ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';
import { categorize, fileExt, formatBytes, type FileCategory } from '../file-meta.util';

/**
 * FILE message row: a compact, fixed-width bubble with a type-tinted icon, the filename, the size, and a download
 * glyph. The whole card is click-to-open-detail: it emits `openFile`, and the thread/playground routes that into the
 * FileDetailService fullscreen overlay (where the full filename + a Download button live). The status tick + time sit
 * outside the click target. Follows the 5 _row-base contracts (border-box height, self-contained width via a fixed
 * px width + max-width:100%, host autonomy).
 *
 * Filename overflow: the nowrap name ellipses inside the fixed 280px bubble — `.msg-file-row` carries `min-width:0`
 * to break the flex min-content chain (a nowrap string's min-content is the whole unbreakable name), and the detail
 * overlay exists precisely so a long name can be read in full without widening the bubble.
 */
@Component({
  selector: 'app-msg-file-row',
  standalone: true,
  imports: [DateRowComponent, UserAvatarComponent, TranslocoPipe, MatProgressSpinnerModule, MatIconModule],
  templateUrl: './file-row.component.html',
  styleUrl: './file-row.component.scss',
})
export class FileRowComponent {
  readonly UserAvatarType = UserAvatarType;
  /** Exposed for the template (status comparisons use MEDIA_STATUS.* — no bare literals). */
  readonly MEDIA_STATUS = MEDIA_STATUS;
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input<boolean>(false);

  readonly side = computed(() => (this.data().isSelf ? 'self' : 'other'));
  readonly showAvatar = computed(() => this.isShowHead());
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  readonly showName = computed(() => this.isShowHead() && !this.data().isSelf);
  readonly statusTick = computed(() => this.data().isSelf && !!this.data().status);
  readonly isSending = computed(
    () => this.data().isSelf && this.data().status === 'sending',
  );
  readonly isFailed = computed(
    () => this.data().isSelf && this.data().status === 'failed',
  );
  readonly retry = output<number>();
  /** Click the card → open the file-detail overlay (full name + Download). */
  readonly openFile = output<void>();

  readonly file = computed(() => this.data().file);
  readonly category = computed<FileCategory>(() =>
    categorize(this.file()?.mimeType ?? ''),
  );
  /** Extension badge (uppercased), derived from the trusted filename the server sanitized. */
  readonly ext = computed(() => fileExt(this.file()?.name ?? ''));
  readonly sizeText = computed(() => formatBytes(this.file()?.size ?? 0));
}
