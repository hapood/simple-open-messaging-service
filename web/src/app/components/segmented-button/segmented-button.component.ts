import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
} from '@angular/core';
import { MatButtonToggleModule } from '@angular/material/button-toggle';

export interface SegmentedButtonOption<T = string> {
  key: T;
  label: string;
  icon?: 'password' | 'otp' | 'qr' | string;
  disabled?: boolean;
}

/**
 * Material 3 Segmented Button Group component.
 *
 * Provides a pill-shaped mutual-exclusion toggle aligned with Material 3 Segmented
 * Button specifications, complete with keyboard accessibility (arrow navigation)
 * and GPU-accelerated rounded ripple clipping on touch devices.
 */
@Component({
  selector: 'app-segmented-button',
  standalone: true,
  imports: [MatButtonToggleModule],
  templateUrl: './segmented-button.component.html',
  styleUrl: './segmented-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SegmentedButtonComponent<T = string> {
  readonly options = input.required<ReadonlyArray<SegmentedButtonOption<T>>>();
  readonly value = model.required<T>();
  readonly ariaLabel = input<string>('Options');
  readonly name = input<string>('segmentedGroup');

  onSelectionChange(selected: T): void {
    if (selected !== undefined && selected !== this.value()) {
      this.value.set(selected);
    }
  }
}
