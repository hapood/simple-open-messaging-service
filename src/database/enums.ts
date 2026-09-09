export const PushPlatform = {
  ANDROID: 'ANDROID',
  WEB: 'WEB',
  IOS: 'IOS',
} as const;
export type PushPlatform = (typeof PushPlatform)[keyof typeof PushPlatform];

export const AdminRole = {
  SUPER_ADMIN: 'SUPER_ADMIN',
  ADMIN: 'ADMIN',
  VIEWER: 'VIEWER',
} as const;
export type AdminRole = (typeof AdminRole)[keyof typeof AdminRole];

export const ContentType = {
  PURE_TEXT: 'PURE_TEXT',
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  FILE: 'FILE',
  AUDIO: 'AUDIO',
  LINK: 'LINK',
  CONTACT_CARD: 'CONTACT_CARD',
  FORWARD: 'FORWARD',
  // Phase 7: multi-asset bundle (N files share one batchId).
  GALLERY: 'GALLERY',
  SYSTEM: 'SYSTEM',
} as const;
export type ContentType = (typeof ContentType)[keyof typeof ContentType];

export const GroupRole = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
} as const;
export type GroupRole = (typeof GroupRole)[keyof typeof GroupRole];

export const MessageThreadType = { P2P: 'P2P', GROUP: 'GROUP' } as const;
export type MessageThreadType =
  (typeof MessageThreadType)[keyof typeof MessageThreadType];

export const MessageDeleteType = {
  USER_RETRACTION: 'USER_RETRACTION',
  MODERATION_REMOVAL: 'MODERATION_REMOVAL',
} as const;
export type MessageDeleteType =
  (typeof MessageDeleteType)[keyof typeof MessageDeleteType];

export const FileSyncDirection = {
  OUTBOUND: 'OUTBOUND',
  INBOUND: 'INBOUND',
} as const;
export type FileSyncDirection =
  (typeof FileSyncDirection)[keyof typeof FileSyncDirection];

export const FileSyncStatus = {
  PENDING: 'PENDING',
  DOWNLOADING: 'DOWNLOADING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  TOMBSTONED: 'TOMBSTONED',
} as const;
export type FileSyncStatus =
  (typeof FileSyncStatus)[keyof typeof FileSyncStatus];

export const FileSyncKind = {
  FILE: 'FILE',
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  AUDIO: 'AUDIO',
  LINK_CARD: 'LINK_CARD',
  BUNDLE: 'BUNDLE',
} as const;
export type FileSyncKind = (typeof FileSyncKind)[keyof typeof FileSyncKind];
