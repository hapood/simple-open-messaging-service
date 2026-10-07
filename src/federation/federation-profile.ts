/** Inline profile avatar transmitted over federation. */
export interface InlineProfileAvatar {
  mimeType: string;
  base64: string;
  width: number;
  height: number;
}

/** Public user or group profile as transmitted over federation. */
export interface S2SProfile {
  /** Profile-subject namespace in the authenticated publisher's namespace space. */
  namespaceId: number;
  account: string;
  displayName: string;
  avatar: InlineProfileAvatar | null;
  bio: string;
  profileRev: number;
}
