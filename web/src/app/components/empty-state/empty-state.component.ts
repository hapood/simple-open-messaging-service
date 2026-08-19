import {
  Component,
  input,
  output,
  ChangeDetectionStrategy,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';

export type EmptyStateTone = 'default' | 'error';

/**
 * Generic empty / loading / error placeholder: icon (content projection) + title + subtitle + optional CTA.
 * Styling extracted from friend-requests's .state-hint. The icon slot auto-hides when nothing is projected (:empty).
 * Projected SVGs carry the consumer's own encapsulation; their size is provided by the consumer in its template.
 */
@Component({
  selector: 'app-empty-state',
  imports: [MatButtonModule],
  templateUrl: './empty-state.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './empty-state.component.scss',
})
export class EmptyStateComponent {
  readonly title = input.required<string>();
  readonly subtitle = input('');
  /** error variant: title is tinted with --app-danger */
  readonly tone = input<EmptyStateTone>('default');
  /** CTA label; the button renders only when non-empty */
  readonly ctaLabel = input('');
  readonly ctaClick = output<void>();
}
