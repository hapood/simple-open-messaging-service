import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';

@Component({
  selector: 'app-dialog-action-footer',
  standalone: true,
  imports: [MatButtonModule],
  templateUrl: './dialog-action-footer.component.html',
  styleUrl: './dialog-action-footer.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DialogActionFooterComponent {
  readonly cancelLabel = input.required<string>();
  readonly primaryLabel = input<string>();
  readonly primaryDisabled = input(false);
  readonly cancelled = output<void>();
  readonly confirmed = output<void>();
}
