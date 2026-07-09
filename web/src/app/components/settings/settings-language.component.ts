import { Component, inject } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatRadioModule } from '@angular/material/radio';
import { TranslocoPipe } from '@jsverse/transloco';
import { LanguageService, AppLang } from '../../services/language.service';

/**
 * Settings → Language sub-page. A radio list of the available languages, each self-identifying in its
 * own script (deliberately not translated). Upgrades the old dropdown to the M3 "choose one" page
 * treatment, which scales and previews native names better. Body-only.
 */
@Component({
  selector: 'app-settings-language',
  imports: [MatListModule, MatRadioModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <h3 class="group-title">{{ 'settings.languageRow' | transloco }}</h3>
      <div class="settings-card">
        <mat-list>
          @for (l of langs; track l) {
            <mat-list-item (click)="select(l)">
              <span matListItemTitle>{{ native(l) }}</span>
              <mat-radio-button
                matListItemMeta
                name="lang"
                [checked]="lang() === l"
                [attr.aria-label]="native(l)">
              </mat-radio-button>
            </mat-list-item>
          }
        </mat-list>
      </div>
    </section>
  `,
  styleUrl: './sub-page.scss',
})
export class SettingsLanguageComponent {
  private readonly langSvc = inject(LanguageService);
  /** Current language preference. */
  readonly lang = this.langSvc.lang;
  /** Languages offered. */
  readonly langs: readonly AppLang[] = this.langSvc.availableLangs;

  /** Native-script self-identifier for a language (`'English'` / `'简体中文'`). */
  native(l: AppLang): string {
    return this.langSvc.langLabelOf(l);
  }

  select(l: AppLang): void {
    this.langSvc.setLang(l);
  }
}
