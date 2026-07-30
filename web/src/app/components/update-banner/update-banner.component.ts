import { Component, computed, effect, inject, input, OnDestroy, output } from '@angular/core';
import { MatSnackBar, MatSnackBarRef, TextOnlySnackBar } from '@angular/material/snack-bar';
import { TranslocoService } from '@jsverse/transloco';
import { UpdateService } from '../../services/update.service';
import { LanguageService } from '../../services/language.service';

/**
 * Global update notification controller. It has no visual DOM of its own: update availability is surfaced
 * through the application's standard bottom-center Material snackbar, sharing placement and behavior with
 * reload prompts and other global feedback.
 */
@Component({
  selector: 'app-update-banner',
  standalone: true,
  template: '',
})
export class UpdateBannerComponent implements OnDestroy {
  readonly update = inject(UpdateService);
  private readonly snackBar = inject(MatSnackBar);
  private readonly transloco = inject(TranslocoService);
  private readonly language = inject(LanguageService);

  /** Playground override; production leaves this null and reads UpdateService.available. */
  readonly demoAvailable = input<boolean | null>(null);
  readonly demoDismiss = output<void>();

  private readonly effectiveAvailable = computed(() => {
    const demo = this.demoAvailable();
    return demo !== null ? demo : this.update.available();
  });

  private ref?: MatSnackBarRef<TextOnlySnackBar>;

  constructor() {
    effect(() => {
      const available = this.effectiveAvailable();
      this.language.lang();

      if (!available) {
        this.ref?.dismiss();
        this.ref = undefined;
        return;
      }
      if (this.ref) return;

      const ref = this.snackBar.open(
        this.transloco.translate('update.banner'),
        this.transloco.translate('update.reload'),
        {
          // An available update remains actionable until the user applies or dismisses it.
          duration: 0,
          panelClass: [
            'soms-snack-bar',
            'soms-snack-bar--interactive',
            'soms-update-snack-bar',
          ],
        },
      );
      this.ref = ref;

      ref.onAction().subscribe(() => void this.update.applyUpdate());
      ref.afterDismissed().subscribe(() => {
        if (this.ref !== ref) return;
        this.ref = undefined;
        if (this.demoAvailable() !== null) this.demoDismiss.emit();
        else this.update.dismiss();
      });
    });
  }

  ngOnDestroy(): void {
    this.ref?.dismiss();
    this.ref = undefined;
  }
}
