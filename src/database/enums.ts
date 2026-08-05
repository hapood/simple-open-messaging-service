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
} as const;
export type ContentType = (typeof ContentType)[keyof typeof ContentType];

export const GroupRole = {
  OWNER: 'OWNER',
  ADMIN: 'ADMIN',
  MEMBER: 'MEMBER',
} as const;
export type GroupRole = (typeof GroupRole)[keyof typeof GroupRole];

export const InviteKind = { FRIEND: 'FRIEND', GROUP: 'GROUP' } as const;
export type InviteKind = (typeof InviteKind)[keyof typeof InviteKind];

export const InviteStatus = {
  PENDING: 'PENDING',
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  REVOKED: 'REVOKED',
  EXPIRED: 'EXPIRED',
} as const;
export type InviteStatus = (typeof InviteStatus)[keyof typeof InviteStatus];

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
