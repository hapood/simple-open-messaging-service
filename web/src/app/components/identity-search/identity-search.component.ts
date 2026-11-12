import {
  ChangeDetectionStrategy,
  Component,
  input,
  model,
  output,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  IdentitySearch,
  IdentitySearchStatus,
} from '../../services/identity-search';
import { AppIconType, IconComponent } from '../icon/icon.component';

@Component({
  selector: 'app-identity-search',
  imports: [
    FormsModule,
    MatButtonModule,
    MatProgressBarModule,
    TranslocoPipe,
    IconComponent,
  ],
  templateUrl: './identity-search.component.html',
  styleUrl: './identity-search.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class IdentitySearchComponent {
  readonly lookup = input.required<IdentitySearch>();
  readonly text = model('');
  readonly readOnly = input(false);
  readonly submitted = output<void>();
  readonly cancelled = output<void>();
  readonly Status = IdentitySearchStatus;
  readonly searchIcon = AppIconType.SEARCH;
}
