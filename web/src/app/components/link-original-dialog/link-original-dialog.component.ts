import {
  Component,
  inject,
  input,
  ChangeDetectionStrategy,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { RouteService } from '../../services/route.service';
import { openExternalUrl } from '../../services/runtime';

@Component({
  selector: 'app-link-original-dialog',
  standalone: true,
  imports: [TranslocoPipe],
  template: `
    <section class="original">
      <h2>{{ 'linkCard.original' | transloco }}</h2>
      <div class="body">{{ text() }}</div>
      <div class="url">{{ url() }}</div>
      <div class="actions">
        <button type="button" class="secondary" (click)="copy()">
          {{ 'linkCard.copy' | transloco }}
        </button>
        <button type="button" class="primary" (click)="open()">
          {{ 'linkCard.open' | transloco }}
        </button>
      </div>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      .original {
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 28px 24px;
        text-align: center;
      }
      h2 {
        margin: 0 0 18px;
        font-size: 22px;
        line-height: 28px;
      }
      .body {
        width: 100%;
        max-height: 52vh;
        overflow: auto;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
        user-select: text;
        font-size: 20px;
        line-height: 30px;
      }
      .url {
        margin-top: 16px;
        color: var(--app-brand);
        user-select: text;
        overflow-wrap: anywhere;
        font-size: 18px;
        line-height: 26px;
      }
      .actions {
        display: flex;
        gap: 12px;
        width: 100%;
        margin-top: 24px;
      }
      button {
        flex: 1;
        min-height: 44px;
        border-radius: var(--app-radius-md);
        font: inherit;
        cursor: pointer;
      }
      .secondary {
        border: 1px solid var(--app-border);
        background: transparent;
        color: var(--app-text);
      }
      .primary {
        border: 0;
        background: var(--app-brand);
        color: white;
      }
    `,
  ],
})
export class LinkOriginalDialogComponent {
  private readonly route = inject(RouteService);
  readonly text = input.required<string>();
  readonly url = input.required<string>();

  async copy(): Promise<void> {
    await navigator.clipboard.writeText(this.text());
  }
  async open(): Promise<void> {
    await openExternalUrl(this.url());
  }
  close(): void {
    this.route.closeDlg();
  }
}
