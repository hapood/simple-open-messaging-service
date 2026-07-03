import { Component, EventEmitter, Output, input } from '@angular/core';
import { GroupInfoComponent } from '../../group-info/group-info.component';
import { PeerProfileComponent } from '../../peer-profile/peer-profile.component';
import { ConversationItem } from '../../../services/model';

/**
 * Desktop right-side info panel. GROUP renders the shared group-info; P2P renders the shared
 * peer-profile. Both own their full layout (header included) and receive closeFn so they can close
 * the panel. Mobile doesn't use this panel — it opens the same components as stacked popups.
 */
@Component({
  selector: 'app-info-pane',
  imports: [GroupInfoComponent, PeerProfileComponent],
  template: `
    <div class="info-pane">
      @if (userMsgTrd(); as trd) {
        @if (trd.type === 'GROUP') {
          <app-group-info [userMsgTrd]="trd" [closeFn]="closeHandler" />
        } @else {
          <app-peer-profile [userMsgTrd]="trd" [closeFn]="closeHandler" />
        }
      }
    </div>
  `,
  styles: [`
    .info-pane { height: 100%; background: var(--app-surface); border-left: 1px solid var(--app-border); box-sizing: border-box; overflow: hidden; }
    app-group-info, app-peer-profile { display: block; height: 100%; }
  `]
})
export class InfoPaneComponent {
  readonly userMsgTrd = input<ConversationItem>()
  @Output() close = new EventEmitter<void>()
  readonly closeHandler = () => this.close.emit()
}
