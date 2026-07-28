import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

const DEFAULT_DURATION = 4000;

/**
 * Routing-independent global feedback facade. All lightweight warnings and informational notices use the
 * same bottom-center Material snackbar as update/reload prompts, so the application has one predictable
 * transient-notification position across routes and form factors.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly snackBar = inject(MatSnackBar);

  warn(message: string, duration: number = DEFAULT_DURATION): void {
    this.show(message, 'soms-snack-bar--warn', duration);
  }

  info(message: string, duration: number = DEFAULT_DURATION): void {
    this.show(message, 'soms-snack-bar--info', duration);
  }

  private show(message: string, kind: string, duration: number): void {
    this.snackBar.open(message, undefined, {
      duration,
      panelClass: ['soms-snack-bar', kind],
    });
  }
}
