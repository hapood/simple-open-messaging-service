import { Component, input } from '@angular/core';
import { TranslocoPipe } from '@jsverse/transloco';
import type { ChatMsgData } from '../message-cards/chat-item';

/**
 * The compact, reusable representation of forwarded content. `original` deliberately keeps the complete
 * render-ready message value so the future send implementation can serialize the real message instead of
 * trying to reconstruct it from the two display strings.
 */
export interface ForwardMessageItem {
  readonly id: number;
  readonly name: string;
  readonly summary: string;
  readonly original: ChatMsgData;
}

export type ForwardRecordKind = 'chat' | 'group';

@Component({
  selector: 'app-forward-message-card',
  standalone: true,
  imports: [TranslocoPipe],
  templateUrl: './forward-message-card.component.html',
  styleUrl: './forward-message-card.component.scss',
})
export class ForwardMessageCardComponent {
  readonly messages = input.required<readonly ForwardMessageItem[]>();
  readonly recordKind = input<ForwardRecordKind>('chat');
  readonly compact = input(false);
  readonly visibleMessages = input(3);

  shownMessages(): readonly ForwardMessageItem[] {
    const limit = Math.max(1, this.visibleMessages());
    return this.messages().slice(0, limit);
  }

  remainingCount(): number {
    return Math.max(0, this.messages().length - this.shownMessages().length);
  }
}
