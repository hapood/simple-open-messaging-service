import { Component, computed, input, output, signal } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../chat-item';
import { DateRowComponent } from '../date-row/date-row.component';
import {
  UserAvatarComponent,
  UserAvatarType,
} from '../../user-avatar/user-avatar.component';
import { assetUrl, openExternalUrl } from '../../../services/runtime';

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
 * LINK message row — a tappable web-page preview card: optional og:image thumbnail strip, the page
 * title, a description, and the page host (+ favicon). Tapping opens the page in the system
 * browser (Tauri) / a new tab (web).
 *
 * `data.text` is the raw JSON written server-side by LinkPreviewService. Shape:
 * `{ url, title, description, image?, favicon? }`. The card renders entirely from this stored
 * metadata — no page fetch on open. Optional artwork is served through the authenticated local CAS.
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
   *  the NEW_MESSAGE echo, which routes through CbElement.update (setInput('data') + detectChanges) —
   *  NOT a remount — so a ngOnInit-once parse would freeze the bare card. A computed re-derives on data
   *  change. (invite-row can use ngOnInit only because an invite is never optimistic-sent.) */
  readonly link = computed<LinkCard>(() => {
    try {
      return JSON.parse(this.data().text) as LinkCard;
    } catch {
      return { url: this.data().text, title: '', description: '' };
    }
  });
  /** Resolve the stored same-origin CAS path for the current runtime. */
  readonly imageSrc = computed(() => assetUrl(this.link().image));
  readonly faviconSrc = computed(() => assetUrl(this.link().favicon));
  /** The page host — the credibility cue shown in the meta bar so a reader can spot a phishing card. */
  readonly host = computed(() => {
    try {
      return new URL(this.link().url).hostname.replace(/^www\./i, '');
    } catch {
      return this.link().url;
    }
  });
  readonly source = computed(() => {
    const siteName = this.link().siteName?.trim();
    return siteName ? `${siteName} · ${this.host()}` : this.host();
  });

  /** Set when the thumbnail <img> fails to load/decode (a corrupt or missing CAS asset) so the card
   *  reflows to text-only instead of showing a broken-image glyph. */
  readonly imgFailed = signal(false);

  /** Open the shared page in the system browser (Tauri) / a new tab (web). */
  async openUrl(): Promise<void> {
    const url = this.link().url;
    if (!url) return;
    try {
      await openExternalUrl(url);
    } catch (error) {
      console.error('[link-row] Failed to open external URL', error);
    }
  }

  onImgError(): void {
    this.imgFailed.set(true);
  }
}
