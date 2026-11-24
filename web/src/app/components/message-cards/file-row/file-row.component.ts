import {
  Component,
  computed,
  input,
  output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { fileMedia } from '../file-media';
import { AlbumMediaCellComponent } from '../media-row/album-media-cell.component';
import { TranslocoPipe } from '@jsverse/transloco';
import type { FileMessageItem } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { QuoteBlockComponent } from '../quote-block/quote-block.component';
import type { HistoryAnchor } from '../../../services/history-anchor';
import { AvatarComponent } from '../../user-avatar/avatar.component';
import type { AvatarView } from '../../user-avatar/avatar-view';
import { messageSenderPresentation } from '../message-sender';
import { formatBytes } from '../file-meta.util';

/**
 * FILE message row: a compact, fixed-width bubble with a type-tinted icon, the filename, the size, and a download
 * glyph. The whole card is click-to-open-detail: it emits `openFile`, and the thread/playground routes that into the
 * shared immersive attachment viewer (where the full filename + a Download button live). The status tick + time sit
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
  imports: [
    QuoteBlockComponent,
    DateRowComponent,
    AvatarComponent,
    TranslocoPipe,
    AlbumMediaCellComponent,
  ],
  templateUrl: './file-row.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './file-row.component.scss',
})
export class FileRowComponent {
  readonly senderView = input<AvatarView>();
  readonly data = input.required<FileMessageItem>();
  readonly quoteJump = output<HistoryAnchor>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  readonly showDate = input<boolean>(false);

  readonly sender = messageSenderPresentation(
    this.data,
    this.isShowHead,
    this.senderView,
  );
  readonly side = this.sender.side;
  readonly showAvatar = this.sender.showAvatar;
  readonly showName = this.sender.showName;
  readonly pos = computed(() => (this.isShowHead() ? 'head' : 'body'));
  /** Click the card → open the immersive attachment viewer (full name + Download). */
  readonly openFile = output<void>();

  readonly media = computed(() => fileMedia(this.data()));
  readonly sizeText = computed(() => formatBytes(this.media().size));
}
