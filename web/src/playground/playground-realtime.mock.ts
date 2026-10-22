import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
import type { StandardMessage } from '../app/services/realtime-transport';

/** In-memory realtime facade for the standalone playground.
 *
 * Production components may inject WebsocketService indirectly even when their message source is
 * replaced. Providing this facade at the playground root preserves that contract without constructing
 * a transport, opening `/events`, or exposing a misleading disconnected state in the production UI.
 */
@Injectable({ providedIn: 'root' })
export class PlaygroundRealtime {
  readonly eventSubject = new Subject<StandardMessage>();
  readonly reconnect$ = new Subject<void>();
  readonly state = signal<'open'>('open');
  readonly reconnectIn = signal<number | null>(null);

  connect(): void {}

  disconnect(): void {}

  retryNow(): void {}
}
