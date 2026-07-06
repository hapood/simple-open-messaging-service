import { Component, computed, effect, inject, signal, viewChild, ElementRef } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoPipe, TranslocoService } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { UserAvatarComponent, UserAvatarType } from '../user-avatar/user-avatar.component';
import { EmptyStateComponent } from '../empty-state/empty-state.component';
import { MsgService } from '../../services/message.service';
import { SearchService } from '../../services/search.service';
import { LanguageService } from '../../services/language.service';
import type { GlobalSearchMessageHit, GlobalSearchThreadHit } from '../../services/model';
import { formatListTime } from '../message-cards/date-format';

interface SnippetSegment {
  text: string;
  hit: boolean;
}

/**
 * The global-search panel. A debounced input drives POST /search/global; results render in two groups
 * — conversations/contacts matched by display name, and messages matched by PURE_TEXT body or FILE
 * name (the server ships a keyword-centered snippet + the hydrated thread/sender display info, so each
 * row renders without a second round-trip). A thread hit opens the conversation; a message hit opens
 * it AND centers the kernel on the matched id (SearchService.openThreadAtMessage → pendingJumpMsgId).
 *
 * Open/close and the message-jump handshake live in SearchService — this component only fires intents
 * (openThread / openThreadAtMessage / close) and renders the result of the last query.
 */
@Component({
  selector: 'app-global-search',
  imports: [FormsModule, TranslocoPipe, IconComponent, UserAvatarComponent, EmptyStateComponent],
  templateUrl: './global-search.component.html',
  styleUrl: './global-search.component.scss',
})
export class GlobalSearchComponent {
  readonly AppIconType = AppIconType;
  readonly UserAvatarType = UserAvatarType;

  private readonly msgService = inject(MsgService);
  private readonly search = inject(SearchService);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  /** Auto-focus the input on mount (zoneless: viewChild resolves via effect, not ngAfterViewInit). */
  private readonly inputEl = viewChild<ElementRef<HTMLInputElement>>('input');
  constructor() {
    effect(() => {
      this.inputEl()?.nativeElement.focus();
    });
  }

  keyword = '';
  readonly loading = signal(false);
  readonly threads = signal<GlobalSearchThreadHit[]>([]);
  readonly messages = signal<GlobalSearchMessageHit[]>([]);
  readonly hasMoreMessages = signal(false);
  /** Whether a search has actually run — distinguishes the initial blank state from "no results". */
  readonly searched = signal(false);

  private timer?: ReturnType<typeof setTimeout>;

  readonly hasResults = computed(() => this.threads().length > 0 || this.messages().length > 0);

  avatarType(type: 'P2P' | 'GROUP'): UserAvatarType {
    return type === 'GROUP' ? UserAvatarType.GROUP : UserAvatarType.OTHER;
  }

  /** Conversation-list timestamp; reads the language signal so it re-evaluates on a language switch. */
  fmtTime(ms: number | null | undefined): string {
    this.language.lang();
    return formatListTime(ms, this.transloco);
  }

  onInput(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runSearch(), 300);
  }

  private runSearch(): void {
    const kw = this.keyword.trim();
    if (!kw) {
      this.threads.set([]);
      this.messages.set([]);
      this.hasMoreMessages.set(false);
      this.searched.set(false);
      return;
    }
    this.loading.set(true);
    this.msgService.globalSearch({ keyword: kw, messageTake: 20, threadTake: 20 }).subscribe((res) => {
      this.loading.set(false);
      this.searched.set(true);
      const data = res.code === 0 ? res.data : undefined;
      this.threads.set(data?.threads ?? []);
      this.messages.set(data?.messages ?? []);
      this.hasMoreMessages.set(data?.hasMoreMessages ?? false);
    });
  }

  /** Split a snippet into segments, marking case-insensitive keyword matches for highlighting. */
  highlight(snippet: string): SnippetSegment[] {
    const kw = this.keyword.trim();
    if (!kw || !snippet) return [{ text: snippet, hit: false }];
    const lower = snippet.toLowerCase();
    const klow = kw.toLowerCase();
    const segs: SnippetSegment[] = [];
    let i = 0;
    let idx = lower.indexOf(klow);
    while (idx >= 0) {
      if (idx > i) segs.push({ text: snippet.slice(i, idx), hit: false });
      segs.push({ text: snippet.slice(idx, idx + kw.length), hit: true });
      i = idx + kw.length;
      idx = lower.indexOf(klow, i);
    }
    if (i < snippet.length) segs.push({ text: snippet.slice(i), hit: false });
    return segs;
  }

  openThread(t: GlobalSearchThreadHit): void {
    this.search.openThread(t.threadId);
  }
  openMessage(m: GlobalSearchMessageHit): void {
    this.search.openThreadAtMessage(m.threadId, m.id);
  }
  close(): void {
    this.search.close();
  }
}
