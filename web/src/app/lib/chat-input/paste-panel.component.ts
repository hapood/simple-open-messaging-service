import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  AppIconType,
  IconComponent,
} from '../../components/icon/icon.component';

export interface PastePanelItem {
  id: string;
  name: string;
  size: number;
  previewUrl?: string;
}

@Component({
  selector: 'app-paste-panel',
  imports: [IconComponent, TranslocoPipe],
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
                  <div class="pp-file-glyph" aria-hidden="true">
                    <app-icon [type]="AppIconType.FILE" />
                  </div>
                }
                <div class="pp-item-copy">
                  <strong [title]="item.name">{{ item.name }}</strong>
                  <span>{{ formatBytes(item.size) }}</span>
                </div>
                <button type="button" class="pp-remove" (click)="remove.emit(item.id)"
                        [attr.aria-label]="'chat.paste.removeItem' | transloco: { name: item.name }">×</button>
              </article>
            }
          </div>

        </div>

        <footer class="pp-actions">
          <button type="button" class="pp-button pp-button--secondary" (click)="cancel.emit()">
            {{ 'common.cancel' | transloco }}
          </button>
          <button type="button" class="pp-button pp-button--primary"
                  [disabled]="items().length === 0" (click)="confirm.emit()">
            {{ 'chat.paste.send' | transloco: { count: items().length } }}
          </button>
        </footer>
      </section>
    </div>
  `,
  styleUrl: './paste-panel.component.scss',
})
export class PastePanelComponent {
  readonly AppIconType = AppIconType;
  readonly items = input.required<readonly PastePanelItem[]>();
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
