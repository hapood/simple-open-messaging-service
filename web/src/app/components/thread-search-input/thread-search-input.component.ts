import {
  Component,
  input,
  output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { AppIconType, IconComponent } from '../icon/icon.component';

@Component({
  selector: 'app-thread-search-input',
  standalone: true,
  imports: [IconComponent],
  templateUrl: './thread-search-input.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './thread-search-input.component.scss',
})
export class ThreadSearchInputComponent {
  readonly AppIconType = AppIconType;
  readonly value = input('');
  readonly placeholder = input('');
  readonly ariaLabel = input('Search');
  readonly clearAriaLabel = input('Clear search');
  readonly valueChange = output<string>();

  updateValue(event: Event): void {
    this.valueChange.emit((event.target as HTMLInputElement).value);
  }

  clear(): void {
    this.valueChange.emit('');
  }
}
