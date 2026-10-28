import {
  Component,
  inject,
  signal,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Location } from '@angular/common';
import { Router } from '@angular/router';
import { TranslocoPipe } from '@jsverse/transloco';
import { MatButtonModule } from '@angular/material/button';
import {
  IconComponent,
  AppIconType,
} from '../../components/icon/icon.component';

/**
 * Wildcard-route fallback (`path: '**'`). A clean, Material Design 3 "Page Not Found"
 * screen conforming to SOMS graphite & action-blue palette, featuring M3 typography,
 * elevation surface tokens, integer-pixel metrics, and accessible navigation.
 */
@Component({
  selector: 'app-page-not-found',
  imports: [TranslocoPipe, MatButtonModule, IconComponent],
  templateUrl: './page-not-found.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './page-not-found.component.scss',
})
export class PageNotFoundComponent {
  private readonly router = inject(Router);
  private readonly location = inject(Location);

  readonly AppIcon = AppIconType;

  /** Best-effort check to prevent rendering a dead "Go back" button. */
  readonly canGoBack = signal(
    typeof history !== 'undefined' && history.length > 1,
  );

  /** Current attempted route url */
  readonly currentPath = signal<string>(this.router.url);

  goHome(): void {
    this.router.navigate(['/']);
  }

  goBack(): void {
    this.location.back();
  }
}
