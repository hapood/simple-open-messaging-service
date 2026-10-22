import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';

/**
 * HTTP 403 destination, mounted at `/forbidden` (no guard). Reached when an access
 * check rejects the authenticated user — e.g. a thread-access guard denying a
 * conversation they aren't a member of. Pairs visually with the 404 page: same
 * layout, tokens, and escape hatches, but a padlock hero + danger accents so the
 * two error pages read as a family while staying distinct.
 */
@Component({
  selector: 'app-forbidden',
  imports: [TranslocoPipe],
  templateUrl: './forbidden-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './forbidden-page.component.scss',
})
export class ForbiddenPageComponent {
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  /** See PageNotFoundComponent — best-effort guard against rendering a dead "Go back". */
  readonly canGoBack = signal(
    typeof history !== 'undefined' && history.length > 1,
  );

  goHome(): void {
    this.router.navigate(['/']);
  }

  goBack(): void {
    this.location.back();
  }
}
