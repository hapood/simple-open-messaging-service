import { Component, inject, signal } from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { BrandLogoComponent } from '../../components/brand-logo/brand-logo.component';

/**
 * Wildcard-route fallback (`path: '**'`). A theme-aware, on-brand "page not found"
 * that stays legible without auth (the wildcard has no guard, so it renders for
 * logged-out visitors too) and routes the user back into the app:
 *   - primary CTA → `/` (authGuard re-protects it, redirecting to login if logged out);
 *   - secondary "Go back" → replays browser history, but only when there is one to
 *     replay (hidden on a direct 404 landing so we never show a dead button).
 */
@Component({
  selector: 'app-page-not-found',
  imports: [BrandLogoComponent, TranslocoPipe],
  templateUrl: './page-not-found.component.html',
  styleUrl: './page-not-found.component.scss',
})
export class PageNotFoundComponent {
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  /** Best-effort: there is a real prior entry to go back to. Imperfect by nature of the
   *  History API, but keeps us from rendering a "Go back" button that silently no-ops. */
  readonly canGoBack = signal(typeof history !== 'undefined' && history.length > 1);

  goHome(): void {
    this.router.navigate(['/']);
  }

  goBack(): void {
    this.location.back();
  }
}
