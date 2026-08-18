import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CallScreenComponent } from '../app/components/call-screen/call-screen.component';
import { CallPresentationService } from '../app/services/call-presentation.service';
import { PlaygroundShellComponent } from './playground-shell.component';
import { PlaygroundCallState } from './playground-call.mock';
import { RootPopupComponent } from '../app/components/root-popup/root-popup.component';

@Component({
  selector: 'app-root',
  imports: [CallScreenComponent, PlaygroundShellComponent, RootPopupComponent],
  template: `
    <app-playground-shell />
    <app-root-popup />
    @if (callState.callState().phase !== 'idle' && !presentation.minimized()) {
      <app-call-screen />
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlaygroundRootComponent {
  readonly callState = inject(PlaygroundCallState);
  readonly presentation = inject(CallPresentationService);
}
