import { Component, inject } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatRadioModule } from '@angular/material/radio';
import { TranslocoPipe } from '@jsverse/transloco';
import { ThemeService, ThemeMode } from '../../services/theme.service';

/**
 * Settings → Appearance sub-page. The theme picker as an M3 radio list (the scalable "choose one of N"
 * treatment for a dedicated page — supersedes the old 3-way segmented toggle, which doesn't grow past a
 * handful of options). Body-only: {@link SettingsComponent} provides the panel shell + header.
 */
@Component({
  selector: 'app-settings-appearance',
  imports: [MatListModule, MatRadioModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          @for (m of modes; track m) {
            <mat-list-item (click)="select(m)">
              <span matListItemTitle>{{ labelKey(m) | transloco }}</span>
              <mat-radio-button
                matListItemMeta
                name="theme"
                [checked]="mode() === m"
                [attr.aria-label]="labelKey(m) | transloco">
              </mat-radio-button>
            </mat-list-item>
          }
        </mat-list>
      </div>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsAppearanceComponent {
  private readonly themeSvc = inject(ThemeService);
  /** Current theme preference (system / light / dark). */
  readonly mode = this.themeSvc.mode;
  /** The three modes in display order. */
  readonly modes: readonly ThemeMode[] = ['system', 'light', 'dark'];

  /** i18n key for a mode's label. */
  labelKey(m: ThemeMode): string {
    return m === 'system' ? 'settings.themeSystem' : m === 'light' ? 'settings.themeLight' : 'settings.themeDark';
  }

  select(m: ThemeMode): void {
    this.themeSvc.setMode(m);
  }

}
