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
 * HTTP 403 destination, mounted at `/forbidden`. A clean, Material Design 3
 * "Access Restricted" screen conforming to SOMS graphite & action-blue palette,
 * sharing the same shortcuts and actions layout as the 404 page.
 */
@Component({
  selector: 'app-forbidden',
  imports: [TranslocoPipe, MatButtonModule, IconComponent],
  templateUrl: './forbidden-page.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './forbidden-page.component.scss',
})
export class ForbiddenPageComponent {
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
