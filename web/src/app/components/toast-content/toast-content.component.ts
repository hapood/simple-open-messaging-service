import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import {
  MAT_SNACK_BAR_DATA,
  MatSnackBarModule,
  MatSnackBarRef,
} from '@angular/material/snack-bar';
import { TranslocoPipe } from '@jsverse/transloco';

export interface ToastContentData {
  message: string;
  action?: string;
}

/** Shared Material snackbar content. Dismissal never invokes the optional business action. */
@Component({
  selector: 'app-toast-content',
  imports: [MatButtonModule, MatSnackBarModule, TranslocoPipe],
  templateUrl: './toast-content.component.html',
  styleUrl: './toast-content.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ToastContentComponent {
  readonly data = inject<ToastContentData>(MAT_SNACK_BAR_DATA);
  readonly ref = inject<MatSnackBarRef<ToastContentComponent>>(MatSnackBarRef);
}
