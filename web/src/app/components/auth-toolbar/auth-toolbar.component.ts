import {
  Component,
  computed,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatSelectModule, MatSelectChange } from '@angular/material/select';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { ThemeService } from '../../services/theme.service';
import { LanguageService, AppLang } from '../../services/language.service';

/**
 * Theme + language bar for the auth (login/register) split-screen shell.
 *
 * The theme button cycles system -> light -> dark (the icon morphs to match).
 * The language control is a `<mat-select>` dropdown — the same picker the
 * Settings page exposes — so appearance and language are both reachable before
 * the user is signed in. The trigger shows the globe icon + the active
 * language's native name; opening it lists every available language.
 *
 * The host is absolutely positioned in the top-right corner of its parent: the
 * auth shell's `.form-pane`, which the `auth-shell` mixin makes
 * `position: relative`. The form card stays centered below it.
 */
@Component({
  selector: 'app-auth-toolbar',
  imports: [IconComponent, TranslocoPipe, MatSelectModule],
  templateUrl: './auth-toolbar.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './auth-toolbar.component.scss',
})
export class AuthToolbarComponent {
  private readonly themeService = inject(ThemeService);
  private readonly languageService = inject(LanguageService);
  private readonly transloco = inject(TranslocoService);

  /** Icon reflecting the current theme mode (predictable cycling affordance). */
  readonly themeIcon = computed<AppIconType>(() => {
    const m = this.themeService.mode();
    return m === 'system'
      ? AppIconType.CONTRAST
      : m === 'light'
        ? AppIconType.SUN
        : AppIconType.MOON;
  });

  /** Human label for the current theme mode. Reads the language signal so it
   *  re-evaluates when the user switches languages. */
  readonly themeLabel = computed(() => {
    this.languageService.lang();
    return this.transloco.translate('auth.theme.' + this.themeService.mode());
  });

  /** Languages offered, in dropdown order (mirrors the Settings picker). */
  readonly availableLangs = this.languageService.availableLangs;
  /** Current language (bound to the `<mat-select>` so the active option is marked). */
  readonly lang = this.languageService.lang;
  /** Native-script label for the current language (trigger + aria-label). */
  readonly langLabel = this.languageService.langLabel;
  /** Native-script label for an arbitrary language id (dropdown options). */
  langLabelOf(l: AppLang): string {
    return this.languageService.langLabelOf(l);
  }

  cycleTheme(): void {
    this.themeService.cycleMode();
  }
  /** Apply a language chosen from the dropdown. */
  onLangChange(e: MatSelectChange): void {
    this.languageService.setLang(e.value as AppLang);
  }
}
