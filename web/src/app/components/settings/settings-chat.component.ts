import { Component, inject, ChangeDetectionStrategy } from '@angular/core';
import { MatListModule } from '@angular/material/list';
import { MatRadioModule } from '@angular/material/radio';
import {
  MatSlideToggleChange,
  MatSlideToggleModule,
} from '@angular/material/slide-toggle';
import { TranslocoPipe } from '@jsverse/transloco';
import {
  ChatAppearanceService,
  type ChatOpenPosition,
} from '../../services/chat-appearance.service';

/** Settings → Chat behavior. Device-local preferences that control conversation presentation/navigation. */
@Component({
  selector: 'app-settings-chat',
  imports: [MatListModule, MatRadioModule, MatSlideToggleModule, TranslocoPipe],
  template: `
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          @for (position of openPositions; track position) {
            <mat-list-item (click)="selectOpenPosition(position)">
              <span matListItemTitle>{{
                openPositionLabel(position) | transloco
              }}</span>
              <span matListItemLine class="hint">{{
                openPositionHint(position) | transloco
              }}</span>
              <mat-radio-button
                matListItemMeta
                name="chat-open-position"
                [checked]="openPosition() === position"
                [attr.aria-label]="openPositionLabel(position) | transloco"
              />
            </mat-list-item>
          }
        </mat-list>
      </div>
    </section>
    <section class="settings-group">
      <div class="settings-card">
        <mat-list>
          <mat-list-item>
            <span matListItemTitle>{{
              'settings.showSelfAvatar' | transloco
            }}</span>
            <span matListItemLine class="hint">{{
              'settings.showSelfAvatarDesc' | transloco
            }}</span>
            <mat-slide-toggle
              matListItemMeta
              [checked]="showSelfAvatar()"
              (change)="onSelfAvatarChange($event)"
              [attr.aria-label]="'settings.showSelfAvatar' | transloco"
            />
          </mat-list-item>
        </mat-list>
      </div>
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sub-page.scss',
})
export class SettingsChatComponent {
  private readonly chatAppearance = inject(ChatAppearanceService);

  readonly showSelfAvatar = this.chatAppearance.showSelfAvatar;
  readonly openPosition = this.chatAppearance.openPosition;
  readonly openPositions: readonly ChatOpenPosition[] = ['latest', 'last-read'];

  selectOpenPosition(position: ChatOpenPosition): void {
    this.chatAppearance.setOpenPosition(position);
  }

  openPositionLabel(position: ChatOpenPosition): string {
    return position === 'latest'
      ? 'settings.chatOpenLatest'
      : 'settings.chatOpenLastRead';
  }

  openPositionHint(position: ChatOpenPosition): string {
    return position === 'latest'
      ? 'settings.chatOpenLatestDesc'
      : 'settings.chatOpenLastReadDesc';
  }

  onSelfAvatarChange(event: MatSlideToggleChange): void {
    this.chatAppearance.setShowSelfAvatar(event.checked);
  }
}
