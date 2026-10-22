import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ThemeService } from '../app/services/theme.service';
import { RouterOutlet } from '@angular/router';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  template: '<router-outlet />',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaygroundShellComponent {
  readonly theme = inject(ThemeService);
}
