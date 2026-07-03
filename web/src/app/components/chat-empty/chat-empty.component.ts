import { Component } from '@angular/core';
import { BrandLogoComponent } from '../brand-logo/brand-logo.component';

/**
 * The no-chat-selected state for the primary chat outlet (the `''` child route). On desktop/tablet it
 * fills the inline chat slot with a branded placeholder; on mobile the shell hides the chat overlay
 * entirely at `/`, so the conversation list shows through — this component is simply not seen there.
 */
@Component({
  selector: 'app-chat-empty',
  imports: [BrandLogoComponent],
  template: `
    <div class="chat-empty">
      <div class="empty-main">
        <app-brand-logo [size]="72" tagline="Select a chat to start your conversation" />
      </div>
      <div class="empty-foot">
        <svg class="lock" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="3" y="11" width="18" height="11" rx="2" />
          <path d="M7 11V7a5 5 0 0 1 10 0v4" />
        </svg>
        <span>Your messages are protected end-to-end in transit. SOMS cannot read them.</span>
      </div>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; }
    .chat-empty {
      display: flex;
      flex-direction: column;
      align-items: center;
      height: 100%;
      padding: 48px 24px;
      box-sizing: border-box;
      background: var(--app-surface);
    }
    .empty-main { flex: 1; display: flex; align-items: center; justify-content: center; width: 100%; }
    .empty-foot {
      flex: 0 0 auto;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      color: var(--app-text-faint);
      font-size: 12px;
      text-align: center;
    }
  `],
})
export class ChatEmptyComponent {}
