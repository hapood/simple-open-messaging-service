import type { Observable } from 'rxjs';
import type { MessageDeletionType } from '../../../../../shared/message-tomb';

export interface MessageDeletionFact {
  seq: number;
  type: MessageDeletionType;
}

export interface MountedMessageDeletionStore {
  deletedLive$: Observable<{
    threadId: number;
    deletions: MessageDeletionFact[];
  }>;
  getMessageDeletions(
    threadId: number,
    seqs: number[],
  ): Promise<MessageDeletionFact[]>;
}

/** One mounted body owns one registration. Subscribe before reading durable facts,
 * then defer delivery so a synchronous event cannot interrupt observer setup.
 * Disposal invalidates both the query and already-queued event callbacks. */
export function watchMountedMessageDeletions(
  store: MountedMessageDeletionStore,
  threadId: number,
  seqs: readonly number[],
  signal: AbortSignal,
  onDeleted: (fact: MessageDeletionFact) => void,
  onError: (error: unknown) => void,
): () => void {
  const wanted = new Set(seqs);
  const delivered = new Set<number>();
  let active = !signal.aborted;
  const deliver = (facts: MessageDeletionFact[]) => {
    queueMicrotask(() => {
      for (const fact of facts) {
        if (!active || signal.aborted) return;
        if (!wanted.has(fact.seq) || delivered.has(fact.seq)) continue;
        delivered.add(fact.seq);
        onDeleted(fact);
      }
    });
  };
  const subscription = store.deletedLive$.subscribe((event) => {
    if (event.threadId === threadId) deliver(event.deletions);
  });
  const dispose = () => {
    active = false;
    subscription.unsubscribe();
    signal.removeEventListener('abort', dispose);
  };
  signal.addEventListener('abort', dispose, { once: true });
  if (active) {
    void store
      .getMessageDeletions(threadId, [...wanted])
      .then(deliver, (error) => {
        if (active && !signal.aborted) onError(error);
      });
  } else dispose();
  return dispose;
}
