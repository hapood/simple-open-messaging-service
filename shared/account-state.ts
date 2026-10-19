/** One fixed record per account cache. Null means that coordinate has not been observed.
 * Request IDs are decimal PostgreSQL bigint strings, never JavaScript numbers. */
export interface AccountState {
  schemaVersion: 1;
  selfProfile: AccountSelfProfile | null;
  selfIdentity: { account: string } | null;
  composerDrafts: AccountComposerDraft[];
  threadFeedCursor: number | null;
  stateFeedId: number | null;
  stateFeedFullThrough: number | null;
  profileNamespaceChangeEndId: number | null;
  intentRequestEndId: string | null;
  intentRequestReadId: string | null;
  intentRequestOptimisticReadId: string | null;
}

export interface AccountSelfProfile {
  id: number;
  account: string;
  name: string;
  avatar: string;
  bio: string;
  isGroup: boolean;
  namespaceId: number;
  profileRev: number;
  isDeleted: boolean;
}

export interface AccountComposerDraft {
  threadId: number;
  html: string;
  plainText: string;
  linkUrl?: string;
  generationId?: string;
  generationExpiresAt?: number;
  generationTriggered?: boolean;
  updatedAt: number;
}
