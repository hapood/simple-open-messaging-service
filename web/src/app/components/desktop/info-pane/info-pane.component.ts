import { Component, EventEmitter, Output, input } from '@angular/core';
import { GroupInfoComponent } from '../../group-info/group-info.component';
import { UserAvatarComponent, UserAvatarType } from '../../user-avatar/user-avatar.component';
import { UserMessageThread } from '../../../services/model';

/**
 * Desktop right-side info panel. GROUP reuses the shared group-info (its own
 * header doubles as the panel header); P2P shows a profile placeholder until
 * shared-media lands.
 */
@Component({
  selector: 'app-info-pane',
  imports: [GroupInfoComponent, UserAvatarComponent],
  template: `
    <div class="info-pane">
      @if (userMsgTrd(); as trd) {
        @if (trd.toObjType === 'GROUP') {
          <app-group-info [userMsgTrd]="trd" [closeFn]="closeHandler" />
        } @else {
          <div class="p2p">
            <div class="panel-header">
              <span class="title">{{ trd.userItem.uniqName }}</span>
              <button class="close-btn" (click)="close.emit()" aria-label="close">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <div class="profile">
              <app-user-avatar [type]="UserAvatarType.OTHER" />
              <div class="name">{{ trd.userItem.uniqName }}</div>
              <div class="hint">共享媒体（即将上线）</div>
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: [`
    .info-pane { height: 100%; background: var(--app-surface); border-left: 1px solid var(--app-border); box-sizing: border-box; overflow: hidden; }
    app-group-info { display: block; height: 100%; }
    .p2p { display: flex; flex-direction: column; height: 100%; }
    .panel-header {
      height: 56px; flex: 0 0 auto; display: flex; align-items: center; justify-content: space-between;
      padding: 0 10px; border-bottom: 1px solid var(--app-border); box-sizing: border-box;
    }
    .title { font-size: 15px; font-weight: 600; }
    .close-btn { border: none; background: transparent; cursor: pointer; color: var(--app-text-muted); display: flex; padding: 4px; border-radius: var(--app-radius-sm); }
    .close-btn:hover { background: var(--app-hover); }
    .profile { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 32px 16px; }
    .name { font-size: 16px; font-weight: 600; }
    .hint { font-size: 13px; color: var(--app-text-faint); }
  `]
})
export class InfoPaneComponent {
  readonly UserAvatarType = UserAvatarType
  readonly userMsgTrd = input<UserMessageThread>()
  @Output() close = new EventEmitter<void>()
  readonly closeHandler = () => this.close.emit()
}
