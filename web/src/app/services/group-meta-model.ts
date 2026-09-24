export interface ClientGroupMetaFeedPage {
  account: string;
  mode: 'full' | 'delta';
  items: Array<
    | {
        feedId: string;
        account: string;
        domain: string;
        namespaceId: number;
        operation: 'UPSERT';
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
        operation: 'DEPART';
        body?: Record<string, never>;
      }
    | {
        feedId: string;
        operation: 'GROUP_PROFILE';
        body: { profileRev: number };
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
  sourceServer: string;
  namespaceId: number;
  page: ClientGroupMetaFeedPage;
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
