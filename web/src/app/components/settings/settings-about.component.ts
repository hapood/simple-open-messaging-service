import { Component, computed } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { TranslocoPipe } from '@jsverse/transloco';
import { isTauri, apiOrigin, apiOriginIsLocalhost } from '../../services/runtime';
import { appVersion } from '../../version';

/**
 * Settings → About sub-page. App version + the configured backend origin (the backend row is only
 * meaningful under Tauri, where the origin is configurable). Body-only.
 */
@Component({
  selector: 'app-settings-about',
  imports: [MatListModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          <mat-list-item>
            <span matListItemTitle>{{ 'settings.version' | transloco }}</span>
            <span class="meta">{{ appVersion }}</span>
          </mat-list-item>
          @if (showBackend) {
            <mat-list-item>
              <span matListItemTitle>{{ 'settings.backend' | transloco }}</span>
              <span class="meta">{{ backendLabel() || ('settings.notConnected' | transloco) }}</span>
            </mat-list-item>
          }
        </mat-list>
      </div>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsAboutComponent {
  readonly appVersion = appVersion;
  /** The Backend row is only meaningful under Tauri (where the origin is configurable). */
  readonly showBackend = isTauri();
  /** Human-readable backend origin, or null when still on the localhost default. */
  readonly backendLabel = computed(() => (apiOrigin && !apiOriginIsLocalhost() ? apiOrigin : null));
}
