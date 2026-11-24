import type { Observable } from 'rxjs';
import type { MessageDeletionType } from '../../../../../shared/message-tomb';

export interface MessageDeletionFact {
  seq: number;
  type: MessageDeletionType;
}

/** Committed deletion events and explicit deletion lookups for presentation. */
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
