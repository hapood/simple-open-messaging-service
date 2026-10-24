import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { CallScreenComponent } from '../app/components/call-screen/call-screen.component';
import { CallPresentationService } from '../app/services/call-presentation.service';
import { HomeShellComponent } from '../app/components/home-shell/home-shell.component';
import { RootPopupComponent } from '../app/components/root-popup/root-popup.component';
import { PlaygroundSocialState } from './playground-social-state';
import { PlaygroundCallState } from './playground-call.mock';
import { PlaygroundControlsComponent } from './playground-controls.component';

@Component({
  selector: 'app-root',
  imports: [
    CallScreenComponent,
    HomeShellComponent,
    PlaygroundControlsComponent,
    RootPopupComponent,
  ],
  template: `
    <app-home-shell />
    <app-playground-controls />
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
  constructor() {
    inject(PlaygroundSocialState).initialize();
  }
}
