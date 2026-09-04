/** Inline profile avatar transmitted over federation. */
export interface InlineProfileAvatar {
  digest: string;
  mimeType: string;
  base64: string;
  width: number;
  height: number;
}

/** Public user or group profile as transmitted over federation. */
export interface S2SProfile {
  account: string;
  domain: string;
  displayName: string;
  avatar: InlineProfileAvatar | null;
  bio: string;
  profileRev: number;
}
