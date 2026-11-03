import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatListModule } from '@angular/material/list';
import { MatCardModule } from '@angular/material/card';
import { MatRadioModule } from '@angular/material/radio';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  AttachmentUploadQueueService,
  UPLOAD_CONCURRENCY_OPTIONS,
} from '../../services/attachment-upload-queue.service';
import {
  MEDIA_CACHE_LIMIT_OPTIONS_MB,
  NativeMediaCacheService,
} from '../../services/native-media-cache.service';

/** Media settings: upload concurrency and native cache capacity. */
@Component({
  selector: 'app-settings-media',
  imports: [
    MatButtonModule,
    MatListModule,
    MatCardModule,
    MatRadioModule,
    TranslocoPipe,
  ],
  template: `
    <section class="settings-group">
      <h3>{{ 'settings.uploadConcurrency' | transloco }}</h3>
      <mat-card appearance="outlined" class="settings-card">
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
      </mat-card>
      <span class="hint">{{
        'settings.uploadConcurrencyHint' | transloco
      }}</span>
    </section>
    @if (showClearCache) {
      <section class="settings-group">
        <h3>{{ 'settings.mediaCache' | transloco }}</h3>
        <mat-card appearance="outlined" class="settings-card">
          <mat-list>
            @for (mb of cacheLimitOptions; track mb) {
              <mat-list-item (click)="selectCacheLimit(mb)">
                <span matListItemTitle>{{
                  'settings.mediaCacheLimitValue'
                    | transloco: { size: cacheSizeLabel(mb) }
                }}</span>
                <mat-radio-button
                  matListItemMeta
                  name="media-cache-limit"
                  [checked]="nativeCache.info().limitMb === mb"
                  [disabled]="updatingCache()"
                  [attr.aria-label]="cacheSizeLabel(mb)"
                />
              </mat-list-item>
            }
          </mat-list>
        </mat-card>
        <span class="hint">{{
          'settings.mediaCacheUsage'
            | transloco
              : {
                  used: formatCacheBytes(nativeCache.info().usedBytes),
                  limit: cacheSizeLabel(nativeCache.info().limitMb),
                }
        }}</span>
      </section>
      <section class="settings-group">
        <mat-card appearance="outlined" class="settings-card">
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
        </mat-card>
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
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sub-page.scss',
})
export class SettingsMediaComponent {
  private readonly uploadQueue = inject(AttachmentUploadQueueService);
  readonly nativeCache = inject(NativeMediaCacheService);

  readonly uploadConcurrency = this.uploadQueue.maxConcurrent;
  readonly uploadOptions: readonly number[] = UPLOAD_CONCURRENCY_OPTIONS;
  readonly showClearCache = this.nativeCache.available;
  readonly cacheLimitOptions = MEDIA_CACHE_LIMIT_OPTIONS_MB;
  readonly clearingCache = signal(false);
  readonly updatingCache = signal(false);
  readonly cacheCleared = signal(false);
  readonly cacheClearFailed = signal(false);

  selectUploadConcurrency(count: number): void {
    this.uploadQueue.setMaxConcurrent(count);
  }

  cacheSizeLabel(mb: number): string {
    return mb >= 1024 ? `${mb / 1024} GB` : `${mb} MB`;
  }

  formatCacheBytes(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    if (bytes < 1024 * 1024 * 1024)
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  async selectCacheLimit(mb: number): Promise<void> {
    if (this.updatingCache()) return;
    this.updatingCache.set(true);
    this.cacheClearFailed.set(false);
    try {
      await this.nativeCache.setLimit(mb);
    } catch {
      this.cacheClearFailed.set(true);
    } finally {
      this.updatingCache.set(false);
    }
  }

  async clearCache(): Promise<void> {
    if (this.clearingCache()) return;
    this.clearingCache.set(true);
    this.cacheCleared.set(false);
    this.cacheClearFailed.set(false);
    try {
      await this.nativeCache.clear();
      this.cacheCleared.set(true);
    } catch {
      this.cacheClearFailed.set(true);
    } finally {
      this.clearingCache.set(false);
    }
  }
}
