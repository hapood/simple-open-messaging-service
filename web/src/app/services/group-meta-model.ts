import type { ClientGroupMetaFact } from '../../../../shared/client-group-meta';
export type { ClientGroupMetaFact };

export interface ClientGroupMetaFeedPage {
  account: string;
  items: ClientGroupMetaFact[];
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
  createdAt: number | null;
  originCreatedAt: number | null;
}

/** Group Meta facts one committed page materialized into the thread row. */
export interface GroupMetaCommitPatch {
  threadId: number;
  groupMetaFeedId: string;
  memberCount: number;
  /** Tri-state announcement fields: a null feedId carries no announcement. */
  announcementFeedId: string | null;
  announcementText: string | null;
  announcementCreatedAt: number | null;
  announcementOriginCreatedAt: number | null;
  groupMetaRecoveryThrough: string | null;
}
