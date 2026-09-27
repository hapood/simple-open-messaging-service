export enum ProfileLookup {
  ACCOUNT_PROFILE = 'ACCOUNT_PROFILE',
  RELATIONSHIP_INTENT_PROFILE = 'RELATIONSHIP_INTENT_PROFILE',
  GROUP_MEMBER_PROFILE = 'GROUP_MEMBER_PROFILE',
}

/** The profile subject and exact revision within a demand namespace. */
export interface ProfileTarget {
  account: string;
  domain: string;
  rev: number;
}

/** The complete immutable profile cache and notification identity. */
export type ProfileKey = ProfileTarget & {
  namespaceId: number;
};

/** Local evidence coordinates used after an exact snapshot has been stored. */
export interface ProfileProjectionKey {
  threadId: number;
  messageSeq: number;
}

export type ProfilePrefetchDemand =
  | {
      namespaceId: number;
      lookup: ProfileLookup.ACCOUNT_PROFILE;
      target: ProfileTarget;
    }
  | {
      namespaceId: number;
      lookup: ProfileLookup.RELATIONSHIP_INTENT_PROFILE;
      target: ProfileTarget;
      peerAccount: string;
    }
  | {
      namespaceId: number;
      lookup: ProfileLookup.GROUP_MEMBER_PROFILE;
      target: ProfileTarget;
      groupAccount: string;
    };

export type ProfileEvidenceProjection =
  | {
      profile: ProfileKey;
      lookup: ProfileLookup.ACCOUNT_PROFILE;
      projection: ProfileProjectionKey;
    }
  | {
      profile: ProfileKey;
      lookup: ProfileLookup.GROUP_MEMBER_PROFILE;
      groupAccount: string;
      projection: ProfileProjectionKey;
    };

/** Client HTTP demands are the projection-free subset. */
export type ProfileClientResolutionDemand = ProfilePrefetchDemand;

/** Server-side exact profile fetch work. Evidence projection is scheduled separately. */
export type ProfileResolutionDemand = ProfilePrefetchDemand;
