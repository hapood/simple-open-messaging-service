import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { ToastContentComponent } from '../components/toast-content/toast-content.component';

const DEFAULT_DURATION = 4000;

export interface ToastOptions {
  duration?: number | 'forever';
}

/** Routing-independent feedback using the same dismissible Material content as update prompts. */
@Injectable({ providedIn: 'root' })
export class ToastService {
  private readonly snackBar = inject(MatSnackBar);

  warn(message: string, options: ToastOptions = {}): void {
    this.show(message, 'soms-snack-bar--warn', options);
  }

  info(message: string, options: ToastOptions = {}): void {
    this.show(message, 'soms-snack-bar--info', options);
  }

  private show(message: string, kind: string, options: ToastOptions): void {
    this.snackBar.openFromComponent(ToastContentComponent, {
      data: { message },
      duration:
        options.duration === 'forever'
          ? 0
          : (options.duration ?? DEFAULT_DURATION),
      panelClass: ['soms-snack-bar', kind, 'soms-snack-bar--passive'],
    });
  }
}
