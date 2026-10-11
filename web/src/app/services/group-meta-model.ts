export interface ClientGroupMetaFeedPage {
  account: string;
  mode: 'full' | 'delta';
  items: Array<
    | {
        feedId: string;
        account: string;
        domain: string;
        namespaceId: number;
        operation: 'MEMBER_UPSERT';
        body: {
          role: 'OWNER' | 'ADMIN' | 'MEMBER';
          profileRev: number;
        };
      }
    | {
        feedId: string;
        account: string;
        domain: string;
        namespaceId: number;
        operation: 'MEMBER_DEPART';
        body?: Record<string, never>;
      }
    | {
        feedId: string;
        operation: 'GROUP_PROFILE';
        body: { profileNamespaceId: number; profileRev: number };
      }
    | {
        feedId: string;
        operation: 'GROUP_ANNOUNCEMENT';
        body: { text: string | null };
      }
  >;
  scannedThrough: string;
  groupMetaFeedEndId: string;
  hasMore: boolean;
}

export interface ClientGroupMetaApply {
  threadId: number;
  namespaceId: number;
  page: ClientGroupMetaFeedPage;
}

/** One announcement fact exactly as materialized into the thread row. */
export interface GroupMetaAnnouncementFact {
  feedId: string;
  text: string | null;
}

/** Group Meta facts one committed page materialized into the thread row. Carried on the
 *  committed notification so the renderer patches its in-memory conversation directly
 *  instead of re-reading the database (and so no presentation write-through can race
 *  the drain). `groupMetaFeedId`/`groupMetaRecoveryThrough` are load-bearing beyond the
 *  visible member count: isGroupMetaCurrent() gates the announcement on them and
 *  group-info reloads its member page when the cursor advances. */
export interface GroupMetaCommitPatch {
  threadId: number;
  groupMetaFeedId: string;
  memberCount: number;
  announcement: GroupMetaAnnouncementFact | null;
  groupMetaRecoveryThrough: string | null;
}

export type GroupMetaProfileReference =
  | {
      type: 'GROUP';
      threadId: number;
      account: string;
      domain: string;
      namespaceId: number;
      rev: number;
    }
  | {
      type: 'GROUP_MEMBER';
      threadId: number;
      account: string;
      domain: string;
      namespaceId: number;
      rev: number;
    };
