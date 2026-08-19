import {
  Component,
  input,
  output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner';
import { TranslocoPipe } from '@jsverse/transloco';

@Component({
  selector: 'app-async-state',
  imports: [MatButtonModule, MatProgressSpinnerModule, TranslocoPipe],
  templateUrl: './async-state.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './async-state.component.scss',
})
export class AsyncStateComponent {
  readonly state = input.required<'loading' | 'error'>();
  readonly errorMessageKey = input('common.loadFailed');
  readonly retryKey = input('common.retry');
  readonly retry = output<void>();
}
