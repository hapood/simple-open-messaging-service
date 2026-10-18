import {
  Component,
  computed,
  inject,
  input,
  output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import { QuoteBlockComponent } from '../quote-block/quote-block.component';
import type { HistoryAnchor } from '../../../services/history-anchor';
import { AvatarComponent } from '../../user-avatar/avatar.component';
import type { AvatarView } from '../../user-avatar/avatar-view';
import { messageSenderPresentation } from '../message-sender';
import { assetUrl } from '../../../services/runtime';
import { ExternalLinkService } from '../../../services/external-link.service';
import { linkCardHost, linkCardSource } from '../../../lib/link-card-display';
import { LinkCardContentComponent } from '../link-card-content/link-card-content.component';

/** The LINK card payload stored as JSON in Message.content (built authoritatively server-side). */
interface LinkCard {
  url: string;
  title: string;
  description: string;
  siteName?: string;
  image?: string;
  favicon?: string;
}

/**
 * LINK message row — a tappable target card with optional artwork, title, description and source.
 * Tapping asks the operating system (Tauri) or browser to open the target.
 *
 * `data.text` is the raw JSON written server-side by LinkPreviewService. Shape:
 * `{ url, title, description, image?, favicon? }`. The card renders entirely from this stored
 * metadata — no page fetch on open. Optional artwork is served through the authenticated local CAS.
 *
 * The host (or scheme for non-web targets) is surfaced in the meta bar. All text renders via `{{ }}` interpolation — auto-escaped, so a hostile page title/description
 * is inert (no [innerHTML]).
 */
@Component({
  selector: 'app-msg-link-row',
  standalone: true,
  imports: [
    QuoteBlockComponent,
    AvatarComponent,
    DateRowComponent,
    TranslocoPipe,
    LinkCardContentComponent,
  ],
  templateUrl: './link-row.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './link-row.component.scss',
})
export class LinkRowComponent {
  private readonly externalLinks = inject(ExternalLinkService);
  readonly senderView = input<AvatarView>();
  readonly data = input.required<ChatMsgData>();
  readonly quoteJump = output<HistoryAnchor>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  /** Whether a date-separator pill should render above this row (first message of its day). */
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
  readonly statusTick = computed(
    () => this.data().isSelf && !!this.data().status,
  );
  readonly isSending = computed(
    () => this.data().isSelf && this.data().status === 'sending',
  );
  readonly isFailed = computed(
    () => this.data().isSelf && this.data().status === 'failed',
  );
  readonly retry = output<number>();
  readonly cancel = output<number>();

  /** The parsed card payload, derived from `data().text` so an in-place update re-parses automatically:
   *  the optimistic bare `{ url }` card is swapped for the server-built rich card (title/image/...) via
   *  the canonical message refresh, which routes through CbElement.update (setInput('data') + detectChanges) —
   *  NOT a remount — so a ngOnInit-once parse would freeze the bare card. A computed re-derives on data
   *  change. */
  readonly link = computed<LinkCard>(() => {
    try {
      return JSON.parse(this.data().text) as LinkCard;
    } catch {
      return { url: this.data().text, title: '', description: '' };
    }
  });
  readonly faviconSrc = computed(() => assetUrl(this.link().favicon));
  /** The host or non-web scheme shown as the card source. */
  readonly host = computed(() => {
    return linkCardHost(this.link().url);
  });
  readonly source = computed(() =>
    linkCardSource(this.link().url, this.link().siteName),
  );

  /** Attempt to open the shared target via the OS handler (Tauri) or browser. */
  async openUrl(): Promise<void> {
    const url = this.link().url;
    if (!url) return;
    try {
      await this.externalLinks.open(url);
    } catch (error) {
      console.error('[link-row] Failed to open external URL', error);
    }
  }
}
