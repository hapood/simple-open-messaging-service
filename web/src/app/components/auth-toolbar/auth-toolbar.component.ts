import { Component, computed, inject } from '@angular/core';
import { TranslocoService, TranslocoPipe } from '@jsverse/transloco';
import { IconComponent, AppIconType } from '../icon/icon.component';
import { ThemeService } from '../../services/theme.service';
import { LanguageService } from '../../services/language.service';

/**
 * Theme + language toggle bar for the auth (login/register) split-screen shell.
 * Mirrors the nav-drawer's cycle-on-click UX — system -> light -> dark, then
 * en -> zh-CN — so appearance and language are reachable before the user is
 * signed in. Renders two icon-only buttons (the theme icon morphs to reflect
 * the current mode; language is always the globe, with the active language in
 * its tooltip/aria-label).
 *
 * The host is absolutely positioned in the top-right corner of its parent: the
 * auth shell's `.form-pane`, which the `auth-shell` mixin makes
 * `position: relative`. The form card stays centered below it.
 */
@Component({
  selector: 'app-auth-toolbar',
  imports: [IconComponent, TranslocoPipe],
  templateUrl: './auth-toolbar.component.html',
  styleUrl: './auth-toolbar.component.scss',
})
export class AuthToolbarComponent {
  readonly AppIconType = AppIconType;

  private readonly themeService = inject(ThemeService);
  private readonly languageService = inject(LanguageService);
  private readonly transloco = inject(TranslocoService);

  /** Icon reflecting the current theme mode (predictable cycling affordance). */
  readonly themeIcon = computed<AppIconType>(() => {
    const m = this.themeService.mode();
    return m === 'system' ? AppIconType.CONTRAST : m === 'light' ? AppIconType.SUN : AppIconType.MOON;
  });

  /** Human label for the current theme mode. Reads the language signal so it
   *  re-evaluates when the user switches languages. */
  readonly themeLabel = computed(() => {
    this.languageService.lang();
    return this.transloco.translate('auth.theme.' + this.themeService.mode());
  });

  /** Native-script label for the current language (always self-identifies). */
  readonly langLabel = this.languageService.langLabel;

  cycleTheme(): void { this.themeService.cycleMode(); }
  cycleLang(): void { this.languageService.cycleLang(); }
}
