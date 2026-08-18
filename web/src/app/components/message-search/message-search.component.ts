import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { TranslocoModule } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { MESSAGE_THREAD_ADAPTER } from '../message-thread/message-thread-adapter';

/**
 * In-chat search field, rendered INSIDE the chat header when "Search" is picked from the action menu —
 * it replaces the title row in-place (same --msg-header-h height), so it adds no height and never
 * collides with the floating date pill. Debounced input drives a server-side substring search
 * (message text and uploaded filenames); the lightweight {seq} matches are stored ascending
 * (oldest-first) and the prev/next
 * arrows jump the parent kernel to each via `jumpTo`. The parent owns the kernel + calls
 * scrollToIndex(seq, 'center', true) — the kernel flashes the row.
 *
 * Loads the first page (50 newest matches). The counter shows `i / n+` when more pages exist (the `+`
 * marks an unbounded tail); paging deeper is deferred — search is a secondary surface and the common
 * case is a handful of matches.
 */
@Component({
  selector: 'app-message-search',
  imports: [FormsModule, TranslocoModule, IconComponent],
  template: `
    <div class="msg-search">
      <div class="msg-search-field">
        <input
          #input
          type="text"
          class="msg-search-input"
          [placeholder]="'chat.searchInChatPlaceholder' | transloco"
          [(ngModel)]="keyword"
          (ngModelChange)="onInput()"
        />
        <span class="msg-search-count">
          @if (hasNoResult()) {
            {{ 'chat.searchNoResult' | transloco }}
          } @else {
            {{ countLabel() }}
          }
        </span>
      </div>
      <div class="msg-search-nav">
        <button
          type="button"
          class="msg-search-btn"
          (click)="prev()"
          [disabled]="!canPrev()"
          aria-label="Previous match"
        >
          ▲
        </button>
        <button
          type="button"
          class="msg-search-btn"
          (click)="next()"
          [disabled]="!canNext()"
          aria-label="Next match"
        >
          ▼
        </button>
      </div>
      <button
        type="button"
        class="msg-search-btn msg-search-close"
        (click)="close.emit()"
        aria-label="Close search"
      >
        <app-icon
          [type]="AppIconType.CLOSE"
          [style]="{ width: '18px', height: '18px' }"
        ></app-icon>
      </button>
    </div>
  `,
  styles: [
    `
      :host {
        // Fill the header's middle slot (the header is a flex row). Taking flex:1 here means the search
        // field replaces the title row IN-PLACE — the header keeps its fixed --msg-header-h height, so the
        // floating date pill below never needs re-anchoring and the viewport never resizes on open/close
        // (no kernel reflow, unlike a displacing sibling bar that shrinks the viewport).
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
      }
      .msg-search {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 0 6px;
        box-sizing: border-box;
      }
      .msg-search-input {
        width: 100%;
        min-width: 0;
        height: 32px;
        border: 1px solid var(--app-border);
        border-radius: var(--app-radius-sm, 8px);
        background: var(--app-bg, transparent);
        color: var(--app-text);
        padding: 0 70px 0 10px;
        font-size: 14px;
        line-height: 20px;
        box-sizing: border-box;
        outline: none;
      }
      .msg-search-input:focus {
        border-color: var(--app-brand);
      }
      .msg-search-field {
        position: relative;
        flex: 1 1 auto;
        min-width: 0;
      }
      .msg-search-count {
        position: absolute;
        top: 6px;
        right: 10px;
        max-width: 58px;
        text-align: right;
        font-size: 12px;
        line-height: 20px;
        color: var(--app-text-soft, var(--app-text));
        opacity: 0.8;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        pointer-events: none;
      }
      .msg-search-nav {
        flex: 0 0 auto;
        display: flex;
        gap: 2px;
      }
      .msg-search-close {
        margin-left: 2px;
      }
      .msg-search-btn {
        flex: 0 0 auto;
        width: 32px;
        height: 32px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: none;
        background: transparent;
        color: var(--app-text);
        cursor: pointer;
        border-radius: var(--app-radius-sm, 8px);
        font-size: 12px;
        line-height: 20px;
      }
      .msg-search-btn:hover:not([disabled]) {
        background: var(--app-hover);
      }
      .msg-search-btn[disabled] {
        opacity: 0.35;
        cursor: default;
      }
    `,
  ],
})
export class MessageSearchComponent {
  readonly AppIconType = AppIconType;
  readonly threadId = input.required<number>();
  /** Emits a message seq to center the kernel on (the parent calls scrollToIndex). */
  readonly jumpTo = output<number>();
  readonly close = output<void>();

  private readonly threadAdapter = inject(MESSAGE_THREAD_ADAPTER);

  keyword = '';
  /** Match seqs ascending (oldest-first) for natural prev/next navigation. */
  private matches: number[] = [];
  /** Current match index into `matches` (-1 = none). */
  private idx = -1;
  readonly position = signal(0); // 1-based for display
  readonly matchCount = signal(0); // matches loaded this page
  readonly hasMore = signal(false);
  readonly loading = signal(false);

  private timer?: ReturnType<typeof setTimeout>;

  readonly countLabel = computed(() => {
    if (this.loading()) return '…';
    const n = this.matchCount();
    if (n === 0) return '';
    const plus = this.hasMore() ? '+' : '';
    return `${this.position()} / ${n}${plus}`;
  });

  hasNoResult(): boolean {
    return !this.loading() && this.matchCount() === 0 && !!this.keyword.trim();
  }

  onInput(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.runSearch(), 300);
  }

  private runSearch(): void {
    const kw = this.keyword.trim();
    const tid = this.threadId();
    if (!kw) {
      this.matches = [];
      this.idx = -1;
      this.position.set(0);
      this.matchCount.set(0);
      this.hasMore.set(false);
      return;
    }
    this.loading.set(true);
    this.threadAdapter
      .searchMessages({ threadId: tid, keyword: kw, take: 50 })
      .subscribe((res) => {
        this.loading.set(false);
        const data = res.code === 0 ? res.data : undefined;
        if (!data || data.length === 0) {
          this.matches = [];
          this.idx = -1;
          this.position.set(0);
          this.matchCount.set(0);
          this.hasMore.set(false);
          return;
        }
        // Server returns newest-first (id desc); reverse to ascending for oldest-first navigation.
        this.matches = data.map((d) => d.seq).reverse();
        this.hasMore.set(!!res.hasMore);
        this.matchCount.set(this.matches.length);
        // Land on the NEWEST match first (the last ascending index), WhatsApp-style.
        this.idx = this.matches.length - 1;
        this.emitCurrent();
      });
  }

  canPrev(): boolean {
    return this.idx > 0;
  }
  canNext(): boolean {
    return this.idx >= 0 && this.idx < this.matches.length - 1;
  }

  prev(): void {
    if (!this.canPrev()) return;
    this.idx--;
    this.emitCurrent();
  }
  next(): void {
    if (!this.canNext()) return;
    this.idx++;
    this.emitCurrent();
  }

  private emitCurrent(): void {
    if (this.idx < 0 || this.idx >= this.matches.length) {
      this.position.set(0);
      return;
    }
    this.position.set(this.idx + 1);
    this.jumpTo.emit(this.matches[this.idx]);
  }
}
