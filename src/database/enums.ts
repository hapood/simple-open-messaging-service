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
  INVITE: 'INVITE',
  IMAGE: 'IMAGE',
  VIDEO: 'VIDEO',
  FILE: 'FILE',
  AUDIO: 'AUDIO',
  LINK: 'LINK',
  CALL: 'CALL',
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

export const ThreadRevisionDirection = {
  ADD: 'ADD',
  DELETE: 'DELETE',
} as const;
export type ThreadRevisionDirection =
  (typeof ThreadRevisionDirection)[keyof typeof ThreadRevisionDirection];

export const MessageDeleteType = {
  WITHDRAW: 'WITHDRAW',
  REPORT: 'REPORT',
} as const;
export type MessageDeleteType =
  (typeof MessageDeleteType)[keyof typeof MessageDeleteType];

export const MessageReportStatus = {
  PENDING: 'PENDING',
  UPHELD: 'UPHELD',
  REJECTED: 'REJECTED',
} as const;
export type MessageReportStatus =
  (typeof MessageReportStatus)[keyof typeof MessageReportStatus];

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
  BUNDLE: 'BUNDLE',
} as const;
export type FileSyncKind = (typeof FileSyncKind)[keyof typeof FileSyncKind];
