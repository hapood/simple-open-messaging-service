import { Component, computed, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';
import { assetUrl, isTauri, openExternalUrl } from '../../../services/runtime';

/** The LINK card payload stored as JSON in Message.content (built authoritatively server-side). */
interface LinkCard {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  /** Base64 data URI of the downscaled og:image thumbnail (inlined on the wire; the DB stores only its
   *  digest); absent when the page had none. */
  image?: string;
}

/**
 * LINK message row — a tappable web-page preview card: optional og:image thumbnail strip, the page
 * title, a description, and the site name (+ favicon on web). Tapping opens the page in the system
 * browser (Tauri) / a new tab (web).
 *
 * `data.text` is the raw JSON written server-side by LinkPreviewService. Shape: `{ url, title?,
 * description?, siteName?, image? }`. The card renders entirely from this stored metadata — no fetch
 * on open. The og:image, when present, is a base64 data URI inlined on the wire (the server reads the file at serialize time); it
 * renders under both web and Tauri's `img-src data:`. The favicon is an external https URL, shown
 * on web only (hidden under Tauri).
 *
 * The page host is always surfaced (meta bar) as a credibility cue so a reader can spot a misleading
 * title. All text renders via `{{ }}` interpolation — auto-escaped, so a hostile page title/description
 * is inert (no [innerHTML]).
 */
@Component({
  selector: 'app-msg-link-row',
  standalone: true,
  imports: [UserAvatarComponent, DateRowComponent, TranslocoPipe],
  templateUrl: './link-row.component.html',
  styleUrl: './link-row.component.scss',
})
export class LinkRowComponent {
  readonly UserAvatarType = UserAvatarType;
  readonly data = input.required<ChatMsgData>();
  readonly isShowHead = input(false);
  readonly isGroupStart = input(false);
  /** Whether a date-separator pill should render above this row (first message of its day). */
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

  /** The parsed card payload, derived from `data().text` so an in-place update re-parses automatically:
   *  the optimistic bare `{ url }` card is swapped for the server-built rich card (title/image/...) via
   *  the NEW_MESSAGE echo, which routes through CbElement.update (setInput('data') + detectChanges) —
   *  NOT a remount — so a ngOnInit-once parse would freeze the bare card. A computed re-derives on data
   *  change. (invite-row can use ngOnInit only because an invite is never optimistic-sent.) */
  readonly link = computed<LinkCard>(() => {
    try {
      return JSON.parse(this.data().text) as LinkCard;
    } catch {
      // A malformed/legacy payload — treat the raw text as a bare URL.
      return { url: this.data().text };
    }
  });
  /** The og:image as it arrives on the wire — a base64 data URI. assetUrl passes `data:` through
   *  unchanged (it is same-origin under both web and Tauri's `img-src data:`). */
  readonly imageSrc = computed(() => assetUrl(this.link().image));
  /** External https favicon — render it only on the web; Tauri's img-src CSP blocks cross-origin https. */
  readonly faviconSrc = computed(() => {
    if (isTauri()) return '';
    try {
      return `https://www.google.com/s2/favicons?domain=${new URL(this.link().url).hostname}&sz=32`;
    } catch {
      return '';
    }
  });
  /** The page host — the credibility cue shown in the meta bar so a reader can spot a phishing card. */
  readonly host = computed(() => {
    try {
      return new URL(this.link().url).hostname;
    } catch {
      return this.link().url;
    }
  });

  /** Set when the thumbnail <img> fails to load/decode (a corrupt or missing data URI) so the card
   *  reflows to text-only instead of showing a broken-image glyph. */
  readonly imgFailed = signal(false);

  /** Open the shared page in the system browser (Tauri) / a new tab (web). */
  openUrl(): void {
    const url = this.link().url;
    if (url) void openExternalUrl(url);
  }

  onImgError(): void {
    this.imgFailed.set(true);
  }
}
