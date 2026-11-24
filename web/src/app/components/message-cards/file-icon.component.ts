import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { FileMedia } from './chat-item';
import { categorize, fileExt } from './file-meta.util';

/** Unknown formats are valid files, not missing attachment metadata. */
@Component({
  selector: 'app-file-icon',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    '[class.large]': 'large()',
    '[attr.data-category]': 'category()',
    'aria-hidden': 'true',
  },
  template: `
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      @if (category() === 'unknown') {
        <path
          class="unknown-mark"
          d="M10 11a2 2 0 1 1 3.3 1.5c-.8.6-1.3 1-1.3 2M12 18h.01"
        />
      }
    </svg>
    @if (extension()) {
      <span class="extension">{{ extension() }}</span>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      width: 100%;
      height: 100%;
      gap: 2px;
      overflow: hidden;
      color: #fff;
      background: #6b7280;
    }
    :host([data-category='pdf']) {
      background: #e53935;
    }
    :host([data-category='doc']) {
      background: #2b6cb0;
    }
    :host([data-category='sheet']) {
      background: #2e7d32;
    }
    :host([data-category='slides']) {
      background: #ef6c00;
    }
    :host([data-category='archive']) {
      background: #7b1fa2;
    }
    :host([data-category='text']) {
      background: #546e7a;
    }
    svg {
      display: block;
      width: 24px;
      height: 24px;
      flex: 0 0 24px;
    }
    .extension {
      display: block;
      max-width: 100%;
      padding: 0 2px;
      box-sizing: border-box;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 8px;
      line-height: 10px;
      font-weight: 700;
    }
    :host(.large) {
      width: 104px;
      height: 120px;
      border-radius: 12px;
      gap: 8px;
    }
    :host(.large) svg {
      width: 72px;
      height: 72px;
      flex-basis: 72px;
    }
    :host(.large) .extension {
      font-size: 12px;
      line-height: 16px;
      padding: 0 8px;
    }
  `,
})
export class FileIconComponent {
  readonly media = input.required<FileMedia>();
  readonly large = input(false);
  readonly category = computed(() => categorize(this.media().mimeType));
  readonly extension = computed(() => fileExt(this.media().name));
}
