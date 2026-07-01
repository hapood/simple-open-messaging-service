import { Injectable, signal } from '@angular/core';
import { ConversationItem } from './model';

/**
 * Desktop right-side info panel state. Shared so the deeply-nested
 * message-header can open/toggle the panel and desktop-home can render it,
 * without threading outputs through the shared message-thread. Meaningful only
 * on desktop; mobile goes through the popup stack instead.
 */
@Injectable({ providedIn: 'root' })
export class InfoPanelService {
  private readonly _thread = signal<ConversationItem | undefined>(undefined)
  readonly thread = this._thread.asReadonly()

  open(thread: ConversationItem) { this._thread.set(thread) }
  close() { this._thread.set(undefined) }
  toggle(thread: ConversationItem) {
    this._thread.update(t => (t?.id === thread.id ? undefined : thread))
  }
}
