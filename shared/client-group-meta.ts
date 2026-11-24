/** Client-only group projections. These operations are not the S2S roster protocol.
 * Coordinates are safe integers. HTTP decimal strings are parsed before use. */

export interface ClientGroupMemberCount {
  operation: 'GROUP_MEMBER_COUNT';
  feedId: number;
  createdAt: number;
  originCreatedAt: number | null;
  body: { memberCount: number };
}

export interface ClientGroupAnnouncement {
  operation: 'GROUP_ANNOUNCEMENT';
  feedId: number;
  createdAt: number;
  originCreatedAt: number | null;
  body: { text: string | null };
}

export type ClientGroupMetaFact =
  | ClientGroupMemberCount
  | ClientGroupAnnouncement;
