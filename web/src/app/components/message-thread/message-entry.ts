/** Business intent is explicit; absent parameters never select an entry mode. */
export type MessageWindowScenario =
  | { kind: 'openConversation' }
  | {
      kind: 'jumpToMessage';
      messageSeq: number;
      anchor: 'top' | 'center' | 'bottom';
      highlight?: boolean;
    }
  | { kind: 'goToLatest' };

/** Entry facts are independent of unread eligibility and later read advancement. */
export interface PreparedMessageEntry {
  readonly lastReadSeq: number;
  readonly hasCachedMessages: boolean;
  /** The retained seed contains the exact known head captured during entry preparation. */
  readonly hasCachedHead: boolean;
}
