import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';

export interface PastePanelItem {
  id: string;
  file: File;
  previewUrl?: string;
}

@Component({
  selector: 'app-paste-panel',
  imports: [TranslocoPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pp-backdrop" role="presentation" (click)="cancel.emit()">
      <section
        class="pp-panel"
        role="dialog"
        aria-modal="true"
        [attr.aria-label]="'chat.paste.title' | transloco"
        (click)="$event.stopPropagation()"
        (paste)="onPaste($event)"
        (keydown.escape)="cancel.emit()"
      >
        <header class="pp-header">
          <div>
            <h2>{{ 'chat.paste.title' | transloco }}</h2>
            <p>{{ 'chat.paste.summary' | transloco: { count: items().length } }}</p>
          </div>
          <button type="button" class="pp-icon-button" (click)="cancel.emit()"
                  [attr.aria-label]="'common.close' | transloco">×</button>
        </header>

        <div class="pp-body">
          <div class="pp-items">
            @for (item of items(); track item.id) {
              <article class="pp-item">
                @if (item.previewUrl) {
                  <img [src]="item.previewUrl" alt="" />
                } @else {
                  <div class="pp-file-glyph" aria-hidden="true">📄</div>
                }
                <div class="pp-item-copy">
                  <strong [title]="item.file.name">{{ item.file.name }}</strong>
                  <span>{{ formatBytes(item.file.size) }}</span>
                </div>
                <button type="button" class="pp-remove" (click)="remove.emit(item.id)"
                        [attr.aria-label]="'chat.paste.removeItem' | transloco: { name: item.file.name }">×</button>
              </article>
            }
          </div>

          <label class="pp-caption">
            <span>{{ 'chat.paste.textLabel' | transloco }}</span>
            <textarea
              rows="4"
              [value]="text()"
              [placeholder]="'chat.paste.textPlaceholder' | transloco"
              (input)="textChange.emit($any($event.target).value)"
            ></textarea>
          </label>
        </div>

        <footer class="pp-actions">
          <button type="button" class="pp-button pp-button--secondary" (click)="cancel.emit()">
            {{ 'common.cancel' | transloco }}
          </button>
          <button type="button" class="pp-button pp-button--primary"
                  [disabled]="items().length === 0 && !text().trim()" (click)="confirm.emit()">
            {{ 'chat.paste.send' | transloco: { count: items().length + (text().trim() ? 1 : 0) } }}
          </button>
        </footer>
      </section>
    </div>
  `,
  styleUrl: './paste-panel.component.scss',
})
export class PastePanelComponent {
  readonly items = input.required<readonly PastePanelItem[]>();
  readonly text = input('');
  readonly textChange = output<string>();
  readonly remove = output<string>();
  readonly cancel = output<void>();
  readonly confirm = output<void>();
  readonly morePaste = output<ClipboardEvent>();

  onPaste(event: ClipboardEvent): void {
    if (!event.clipboardData || event.clipboardData.files.length === 0) return;
    event.preventDefault();
    this.morePaste.emit(event);
  }

  formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
