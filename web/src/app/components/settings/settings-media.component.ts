import { Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatRadioModule } from '@angular/material/radio';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import {
  MediaSizeThresholdService,
  MEDIA_THRESHOLD_OPTIONS_KB,
} from '../../services/media-size-threshold.service';
import {
  AttachmentUploadQueueService,
  UPLOAD_CONCURRENCY_OPTIONS,
} from '../../services/attachment-upload-queue.service';
import { clearNativeMediaCache, isAndroidNative } from '../../services/runtime';

/**
 * Settings → Media sub-page. The image size-threshold picker as an M3 radio list (the old dropdown was
 * the only settings control still using a `<mat-select>` — a radio page is the scalable M3 treatment and
 * keeps every Settings choice consistent). Body-only.
 */
@Component({
  selector: 'app-settings-media',
  imports: [MatButtonModule, MatListModule, MatRadioModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          @for (kb of options; track kb) {
            <mat-list-item (click)="select(kb)">
              <span matListItemTitle>{{ label(kb) }}</span>
              <mat-radio-button
                matListItemMeta
                name="media-threshold"
                [checked]="current() === kb"
                [attr.aria-label]="label(kb)"
              >
              </mat-radio-button>
            </mat-list-item>
          }
        </mat-list>
      </div>
      <span class="hint">{{ 'settings.mediaThresholdHint' | transloco }}</span>
    </section>
    <section class="settings-group">
      <h3>{{ 'settings.uploadConcurrency' | transloco }}</h3>
      <div class="settings-card">
        <mat-list>
          @for (count of uploadOptions; track count) {
            <mat-list-item (click)="selectUploadConcurrency(count)">
              <span matListItemTitle>
                {{ 'settings.uploadConcurrencyCount' | transloco: { count } }}
              </span>
              <mat-radio-button
                matListItemMeta
                name="upload-concurrency"
                [checked]="uploadConcurrency() === count"
                [attr.aria-label]="
                  'settings.uploadConcurrencyCount' | transloco: { count }
                "
              >
              </mat-radio-button>
            </mat-list-item>
          }
        </mat-list>
      </div>
      <span class="hint">{{
        'settings.uploadConcurrencyHint' | transloco
      }}</span>
    </section>
    @if (showClearCache) {
      <section class="settings-group">
        <h3>{{ 'settings.mediaCache' | transloco }}</h3>
        <div class="settings-card">
          <mat-list>
            <mat-list-item>
              <span matListItemTitle>{{
                'settings.clearMediaCache' | transloco
              }}</span>
              <span matListItemLine class="hint">{{
                'settings.clearMediaCacheDesc' | transloco
              }}</span>
              <button
                mat-button
                matListItemMeta
                type="button"
                [disabled]="clearingCache()"
                (click)="clearCache()"
              >
                {{
                  (clearingCache()
                    ? 'settings.clearingMediaCache'
                    : 'settings.clearMediaCacheAction'
                  ) | transloco
                }}
              </button>
            </mat-list-item>
          </mat-list>
        </div>
        @if (cacheCleared()) {
          <span class="hint">{{
            'settings.mediaCacheCleared' | transloco
          }}</span>
        } @else if (cacheClearFailed()) {
          <span class="hint">{{
            'settings.mediaCacheClearFailed' | transloco
          }}</span>
        }
      </section>
    }
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsMediaComponent {
  private readonly media = inject(MediaSizeThresholdService);
  private readonly uploadQueue = inject(AttachmentUploadQueueService);
  private readonly transloco = inject(TranslocoService);

  /** Current threshold in KB (0 = unlimited). */
  readonly current = this.media.kb;
  /** The offered threshold options. */
  readonly options: readonly number[] = MEDIA_THRESHOLD_OPTIONS_KB;
  readonly uploadConcurrency = this.uploadQueue.maxConcurrent;
  readonly uploadOptions: readonly number[] = UPLOAD_CONCURRENCY_OPTIONS;
  readonly showClearCache = isAndroidNative();
  readonly clearingCache = signal(false);
  readonly cacheCleared = signal(false);
  readonly cacheClearFailed = signal(false);

  /** Display label for a threshold option: "512 KB" / "1 MB" / "2 MB" / "No limit". */
  label(kb: number): string {
    if (kb <= 0) return this.transloco.translate('settings.noLimit');
    if (kb >= 1024) return `${kb / 1024} MB`;
    return `${kb} KB`;
  }

  select(kb: number): void {
    this.media.setKb(kb);
  }

  selectUploadConcurrency(count: number): void {
    this.uploadQueue.setMaxConcurrent(count);
  }

  clearCache(): void {
    if (this.clearingCache()) return;
    this.clearingCache.set(true);
    this.cacheCleared.set(false);
    this.cacheClearFailed.set(false);
    try {
      clearNativeMediaCache();
      this.cacheCleared.set(true);
    } catch {
      this.cacheClearFailed.set(true);
    } finally {
      this.clearingCache.set(false);
    }
  }
}
