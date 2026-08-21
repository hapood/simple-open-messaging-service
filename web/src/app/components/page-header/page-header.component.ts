import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { AppIconType, IconComponent } from '../icon/icon.component';

/**
 * Standard navigation header for secondary pages and full-panel editors.
 *
 * The component owns navigation sizing and title alignment. Callers may project
 * a trailing action, but must not size the back icon or recreate the side tracks.
 */
@Component({
  selector: 'app-page-header',
  imports: [IconComponent, TranslocoPipe],
  templateUrl: './page-header.component.html',
  styleUrl: './page-header.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PageHeaderComponent {
  readonly title = input.required<string>();
  readonly titleAlign = input<'center' | 'start'>('center');
  readonly showBack = input(true);
  readonly backDisabled = input(false);
  readonly safeArea = input(false);
  readonly back = output<void>();

  readonly AppIconType = AppIconType;
}
