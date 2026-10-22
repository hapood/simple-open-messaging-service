import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';

const DEFAULT_DURATION = 4000;

export interface ToastOptions {
  duration?: number | 'forever';
  interactive?: boolean;
}

interface NormalizedToastOptions {
  duration: number;
  interactive: boolean;
}

/**
 * Routing-independent global feedback facade. All lightweight warnings and informational notices use the
 * same bottom-center Material snackbar as update/reload prompts, so the application has one predictable
 * transient-notification position across routes and form factors.
 */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly snackBar = inject(MatSnackBar);

  warn(message: string, options: number | ToastOptions = {}): void {
    this.show(message, 'soms-snack-bar--warn', this.normalizeOptions(options));
  }

  info(message: string, options: number | ToastOptions = {}): void {
    this.show(message, 'soms-snack-bar--info', this.normalizeOptions(options));
  }

  private show(message: string, kind: string, options: NormalizedToastOptions): void {
    this.snackBar.open(message, undefined, {
      duration: options.duration,
      panelClass: [
        'soms-snack-bar',
        kind,
        options.interactive
          ? 'soms-snack-bar--interactive'
          : 'soms-snack-bar--passive',
      ],
    });
  }

  private normalizeOptions(options: number | ToastOptions): NormalizedToastOptions {
    if (typeof options === 'number') {
      return { duration: options, interactive: false };
    }
    return {
      duration:
        options.duration === 'forever'
          ? 0
          : (options.duration ?? DEFAULT_DURATION),
      interactive: options.interactive ?? false,
    };
  }
}
