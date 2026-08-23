import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatMenuModule } from '@angular/material/menu';
import { AppIconType, IconComponent } from '../icon/icon.component';

export interface SplitButtonOption<T extends string = string> {
  readonly label: string;
  readonly value: T;
  readonly disabled?: boolean;
}

@Component({
  selector: 'app-split-button',
  standalone: true,
  imports: [MatButtonModule, MatMenuModule, IconComponent],
  templateUrl: './split-button.component.html',
  styleUrl: './split-button.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SplitButtonComponent<T extends string = string> {
  protected readonly AppIconType = AppIconType;

  readonly label = input.required<string>();
  readonly menuAriaLabel = input.required<string>();
  readonly disabled = input(false);
  readonly options = input.required<readonly SplitButtonOption<T>[]>();
  readonly selectedValue = input<T | null>(null);

  readonly primaryAction = output<void>();
  readonly optionAction = output<T>();
}
