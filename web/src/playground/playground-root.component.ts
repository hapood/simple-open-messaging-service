import { ChangeDetectionStrategy, Component } from '@angular/core';
import { PlaygroundShellComponent } from './playground-shell.component';

@Component({
  selector: 'app-root',
  imports: [PlaygroundShellComponent],
  template: '<app-playground-shell />',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaygroundRootComponent {}
