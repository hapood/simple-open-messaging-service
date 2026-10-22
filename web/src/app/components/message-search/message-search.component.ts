import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  ChangeDetectionStrategy,
  DestroyRef,
} from '@angular/core';
import { Subscription } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { TranslocoModule } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { MESSAGE_THREAD_ADAPTER } from '../message-thread/message-thread-adapter';

/**
 * In-chat search field, rendered INSIDE the chat header when "Search" is picked from the action menu —
 * it replaces the title row in-place (same --msg-header-h height), so it adds no height and never
 * collides with the floating date pill. Debounced input drives a server-side substring search
 * (message text and uploaded filenames); the lightweight {seq} matches are stored newest-first.
 * The prev/next arrows jump the parent kernel to each via `jumpTo`. The parent owns the kernel + calls
 * scrollToIndex(seq, 'center', true) — the kernel flashes the row.
 *
 * Loads 50 matches at a time. Older matches are fetched by cursor when Previous reaches the
 * loaded boundary; the counter uses the server's total visible match count.
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
  changeDetection: ChangeDetectionStrategy.OnPush,
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
  /** Match seqs newest-first; index zero is the newest visible match. */
  private matches: number[] = [];
  private idx = -1;
  readonly position = signal(0);
  readonly totalCount = signal(0);
  readonly hasMore = signal(false);
  readonly loading = signal(false);

  private timer?: ReturnType<typeof setTimeout>;
  private request?: Subscription;
  private generation = 0;
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.timer);
      this.request?.unsubscribe();
    });
  }

  readonly countLabel = computed(() => {
    if (this.loading() && this.idx < 0) return '…';
    if (this.idx < 0) return '';
    return `${this.position()} / ${this.totalCount()}`;
  });

  hasNoResult(): boolean {
    return !this.loading() && this.idx < 0 && !!this.keyword.trim();
  }

  onInput(): void {
    clearTimeout(this.timer);
    this.request?.unsubscribe();
    this.generation++;
    this.matches = [];
    this.idx = -1;
    this.position.set(0);
    this.totalCount.set(0);
    this.hasMore.set(false);
    this.loading.set(false);
    if (this.keyword.trim())
      this.timer = setTimeout(() => this.runSearch(), 300);
  }

  private runSearch(lastSeq?: number): void {
    const kw = this.keyword.trim();
    if (!kw) return;
    const tid = this.threadId();
    const generation = this.generation;
    this.loading.set(true);
    this.request = this.threadAdapter
      .searchMessages({ threadId: tid, keyword: kw, take: 50, lastSeq })
      .subscribe({
        next: (res) => {
          if (generation !== this.generation || tid !== this.threadId()) return;
          this.loading.set(false);
          if (res.code !== 0 || !res.data) return;
          const seqs = res.data.map((d) => d.seq);
          this.matches =
            lastSeq === undefined ? seqs : [...this.matches, ...seqs];
          this.hasMore.set(!!res.hasMore && seqs.length > 0);
          this.totalCount.set(res.totalCount ?? this.matches.length);
          if (lastSeq !== undefined && seqs.length === 0) return;
          this.idx =
            lastSeq === undefined ? (seqs.length ? 0 : -1) : this.idx + 1;
          this.emitCurrent();
        },
        error: () => {
          if (generation === this.generation) this.loading.set(false);
        },
      });
  }

  canPrev(): boolean {
    return (
      this.idx >= 0 &&
      !this.loading() &&
      (this.idx < this.matches.length - 1 || this.hasMore())
    );
  }
  canNext(): boolean {
    return this.idx > 0 && !this.loading();
  }

  prev(): void {
    if (!this.canPrev()) return;
    if (this.idx === this.matches.length - 1) {
      this.runSearch(this.matches[this.idx]);
    } else {
      this.idx++;
      this.emitCurrent();
    }
  }
  next(): void {
    if (!this.canNext()) return;
    this.idx--;
    this.emitCurrent();
  }

  private emitCurrent(): void {
    if (this.idx < 0 || this.idx >= this.matches.length) {
      this.position.set(0);
      return;
    }
    this.position.set(this.totalCount() - this.idx);
    this.jumpTo.emit(this.matches[this.idx]);
  }
}
