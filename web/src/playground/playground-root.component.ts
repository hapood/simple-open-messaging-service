import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CallScreenComponent } from '../app/components/call-screen/call-screen.component';
import { PlaygroundShellComponent } from './playground-shell.component';
import { PlaygroundCallState } from './playground-call.mock';

@Component({
  selector: 'app-root',
  imports: [CallScreenComponent, PlaygroundShellComponent],
  template: `
    <app-playground-shell />
    @if (callState.callState().phase !== 'idle') {
      <app-call-screen />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaygroundRootComponent {
  readonly callState = inject(PlaygroundCallState);
}
