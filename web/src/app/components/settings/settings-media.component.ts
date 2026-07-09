import { Component, inject } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatRadioModule } from '@angular/material/radio';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import {
  MediaSizeThresholdService,
  MEDIA_THRESHOLD_OPTIONS_KB,
} from '../../services/media-size-threshold.service';

/**
 * Settings → Media sub-page. The image size-threshold picker as an M3 radio list (the old dropdown was
 * the only settings control still using a `<mat-select>` — a radio page is the scalable M3 treatment and
 * keeps every Settings choice consistent). Body-only.
 */
@Component({
  selector: 'app-settings-media',
  imports: [MatListModule, MatRadioModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <h3 class="group-title">{{ 'settings.mediaThreshold' | transloco }}</h3>
      <div class="settings-card">
        <mat-list>
          @for (kb of options; track kb) {
            <mat-list-item (click)="select(kb)">
              <span matListItemTitle>{{ label(kb) }}</span>
              <mat-radio-button
                matListItemMeta
                name="media-threshold"
                [checked]="current() === kb"
                [attr.aria-label]="label(kb)">
              </mat-radio-button>
            </mat-list-item>
          }
        </mat-list>
      </div>
      <span class="hint">{{ 'settings.mediaThresholdHint' | transloco }}</span>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsMediaComponent {
  private readonly media = inject(MediaSizeThresholdService);
  private readonly transloco = inject(TranslocoService);

  /** Current threshold in KB (0 = unlimited). */
  readonly current = this.media.kb;
  /** The offered threshold options. */
  readonly options: readonly number[] = MEDIA_THRESHOLD_OPTIONS_KB;

  /** Display label for a threshold option: "512 KB" / "1 MB" / "2 MB" / "No limit". */
  label(kb: number): string {
    if (kb <= 0) return this.transloco.translate('settings.noLimit');
    if (kb >= 1024) return `${kb / 1024} MB`;
    return `${kb} KB`;
  }

  select(kb: number): void {
    this.media.setKb(kb);
  }
}
