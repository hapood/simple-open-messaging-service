/** Inline profile avatar transmitted over federation. */
export interface InlineProfileAvatar {
  mimeType: string;
  base64: string;
  width: number;
  height: number;
}

/** Internal profile projection. Revision zero uses account-name presentation only;
 * it is never a stored snapshot. Public wire responses nest content or use null. */
export interface S2SProfile {
  /** Profile-subject namespace in the authenticated publisher's namespace space. */
  namespaceId: number;
  account: string;
  displayName: string;
  avatar: InlineProfileAvatar | null;
  bio: string;
  profileRev: number;
}
