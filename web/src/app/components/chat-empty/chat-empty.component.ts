import { Component, ChangeDetectionStrategy } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import { BrandLogoComponent } from '../brand-logo/brand-logo.component';

/**
 * The no-chat-selected state for the primary chat outlet (the `''` child route). On desktop/tablet it
 * fills the inline chat slot with a branded placeholder; on mobile the shell hides the chat overlay
 * entirely at `/`, so the conversation list shows through — this component is simply not seen there.
 */
@Component({
  selector: 'app-chat-empty',
  imports: [BrandLogoComponent, TranslocoPipe],
  template: `
    <div class="chat-empty">
      <div class="empty-main">
        <app-brand-logo
          [size]="72"
          [tagline]="'chat.emptyTagline' | transloco"
        />
      </div>
    </div>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
      }
      .chat-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        height: 100%;
        padding: 48px 24px;
        box-sizing: border-box;
        background: var(--app-chat-pane-bg);
      }
      .empty-main {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        width: 100%;
      }
    `,
  ],
})
export class ChatEmptyComponent {}
