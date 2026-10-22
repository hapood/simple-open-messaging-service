import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import { type IdentifiedLine, splitSearchHighlights } from './debug-log-merge';

@Component({
  selector: 'app-debug-log-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="dbg-line lvl-{{ line().level }}"
      [class.selected]="selected()"
      [attr.data-log-id]="line().id"
      [attr.aria-selected]="selected()"
      role="option"
      tabindex="-1"
      (click)="select.emit(line().id)"
      (dblclick)="copy.emit(line())"
    >
      <span class="ts">{{ displayTime() }}</span>
      <span class="level">{{ line().level }}</span>
      <span class="source src-{{ line().source }}">{{ line().source }}</span>
      <span class="msg">
        @for (part of messageParts(); track $index) {
          @if (part.matched) {
            <mark>{{ part.text }}</mark>
          } @else {
            {{ part.text }}
          }
        }
      </span>
      @if (selected()) {
        <button
          type="button"
          class="detail-toggle"
          (click)="toggleDetails($event)"
          [attr.aria-expanded]="expanded()"
          aria-label="Toggle raw log details"
        >
          {{ expanded() ? '▾' : '▸' }}
        </button>
      }
    </div>
    @if (selected() && expanded()) {
      <section class="details" aria-label="Raw log details">
        <dl>
          <div>
            <dt>Timestamp</dt>
            <dd>{{ line().rawTs || 'unavailable' }}</dd>
          </div>
          <div>
            <dt>Level</dt>
            <dd>{{ line().level }}</dd>
          </div>
          <div>
            <dt>Source</dt>
            <dd>{{ line().source }}</dd>
          </div>
        </dl>
        <pre>{{ line().raw }}</pre>
        <button type="button" (click)="copy.emit(line())">Copy raw line</button>
      </section>
    }
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .dbg-line {
        display: grid;
        grid-template-columns: 84px 44px 54px minmax(0, 1fr) 20px;
        align-items: flex-start;
        gap: 6px;
        min-height: 18px;
        border-radius: 3px;
        white-space: pre-wrap;
        word-break: break-word;
        cursor: default;
      }
      .dbg-line:hover {
        background: rgba(255, 255, 255, 0.04);
      }
      .dbg-line.selected {
        background: rgba(59, 130, 246, 0.22);
        outline: 1px solid rgba(96, 165, 250, 0.55);
      }
      .level,
      .source {
        font-size: 10px;
        line-height: 18px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .source {
        opacity: 0.8;
      }
      .source.src-js {
        color: #60a5fa;
      }
      .source.src-rust {
        color: #f59e0b;
      }
      .source.src-kotlin {
        color: #4ade80;
      }
      .ts {
        color: #777;
      }
      .lvl-error .level,
      .lvl-error .msg {
        color: #ff6b6b;
      }
      .lvl-warn .level,
      .lvl-warn .msg {
        color: #ffd166;
      }
      .lvl-info .level,
      .lvl-log .level {
        color: #aaa;
      }
      .lvl-debug .level,
      .lvl-debug .msg {
        color: #888;
      }
      mark {
        border-radius: 2px;
        background: #fde047;
        color: #111827;
        padding: 0 1px;
      }
      .detail-toggle {
        border: 0;
        background: transparent;
        color: #93c5fd;
        padding: 0;
        line-height: 18px;
        cursor: pointer;
      }
      .details {
        margin: 3px 0 7px 90px;
        padding: 8px 10px;
        border-left: 2px solid #3b82f6;
        background: #181818;
        color: #bbb;
      }
      dl {
        display: flex;
        flex-wrap: wrap;
        gap: 4px 16px;
        margin: 0 0 6px;
        font:
          11px/16px system-ui,
          sans-serif;
      }
      dl div {
        display: flex;
        gap: 5px;
      }
      dt {
        color: #777;
      }
      dd {
        margin: 0;
        color: #ddd;
      }
      pre {
        margin: 0;
        white-space: pre-wrap;
        word-break: break-word;
        font: inherit;
        color: #e6e6e6;
      }
      .details button {
        margin-top: 8px;
        border: 1px solid #444;
        border-radius: 6px;
        background: #242424;
        color: #ddd;
        padding: 3px 8px;
        cursor: pointer;
      }
      @media (max-width: 599px) {
        .dbg-line {
          grid-template-columns: 78px 40px 48px minmax(0, 1fr) 18px;
          gap: 4px;
        }
        .details {
          margin-left: 0;
        }
      }
    `,
  ],
})
export class DebugLogRowComponent {
  readonly line = input.required<IdentifiedLine>();
  readonly selected = input(false);
  readonly matcher = input<RegExp | null>(null);
  readonly select = output<number>();
  readonly copy = output<IdentifiedLine>();
  readonly expanded = signal(false);

  readonly displayTime = computed(() =>
    this.line().rawTs ? this.line().rawTs.slice(11, 23) : '--:--:--.---',
  );
  readonly messageParts = computed(() =>
    splitSearchHighlights(this.line().text, this.matcher()),
  );

  toggleDetails(event: MouseEvent): void {
    event.stopPropagation();
    this.expanded.update((value) => !value);
  }
}
