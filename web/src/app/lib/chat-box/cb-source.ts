/**
 * Source contract for the generic message-window kernel.
 *
 * Sources return chronological raw messages and explicit non-message rows. Album
 * grouping belongs to the kernel. Display-only rows may have synthetic identities;
 * the source translates those identities into directional history coordinates.
 * The kernel never interprets a message ID as an initialization mode.
 *
 * Sources own cache/transport and boundary evidence. The kernel owns mounted
 * rows, position, and demand subscription lifetime. Trimming forgets rendered
 * content; subsequent paging reads ordinary source history again.
 */
import type { CbItem } from './chat-box-scroller';
import type { Observable } from 'rxjs';

export interface CbSourceWindowContext {
  chatId?: number;
  /** Cancels the binding's consumer; propagate it to owned I/O. */
  signal?: AbortSignal;
}

/** Data intent is explicit and independent of source initialization state. */
export type CbSourceWindowRequest =
  | { kind: 'cached'; count: number }
  | { kind: 'latest'; count: number }
  | { kind: 'start'; count: number }
  | {
      kind: 'around';
      messageId: number;
      olderCount: number;
      newerCount: number;
    };

/** Unsubscription detaches this consumer; underlying cancellation follows source ownership. */
export type CbDemand<T> = Observable<CbDemandResult<T>>;

export type CbDemandResult<T> =
  | { readonly kind: 'items'; readonly items: CbItem<T>[] }
  | { readonly kind: 'boundary' }
  | { readonly kind: 'error'; readonly error: unknown };

export interface CbSource<T = unknown> {
  /** A display interval owns this subscription only while mounted. Each delivery
   * replaces that interval, never the surrounding message window. */
  watchInterval?(item: CbItem<T>): Observable<CbItem<T>[]>;
  /** Load one explicitly selected window; return chronological raw items with boundaries. */
  loadWindow(
    request: CbSourceWindowRequest,
    context?: CbSourceWindowContext,
  ): Promise<CbItem<T>[]>;
  /** Older history excludes the source cursor; the floor completes with boundary. */
  requestOlder(cursorId: number, count: number): CbDemand<T>;
  /** Newer history excludes a concrete cursor; at the head it waits for data. */
  requestNewer(cursorId: number, count: number): CbDemand<T>;
  /** No history is mounted: wait for messages after the captured entry read position. */
  requestMessagesForEmptyWindow(count: number): CbDemand<T>;
  /** External availability never mounts directly; active demand receives the data. */
  pushLive(items: CbItem<T>[]): void;
  destroy(): void;
}
