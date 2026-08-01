import { relations } from 'drizzle-orm/relations';
import {
  admin,
  adminSession,
  forwardBundle,
  forwardMessage,
  message,
  messageThread,
  threadParticipant,
  user,
  mediaMessage,
  userBlock,
  pushToken,
  invite,
  adminActionLog,
  pendingMedia,
  group,
  threadRevision,
  loginCode,
  sessionToken,
  twoFactorBackupCode,
  webAuthnCredential,
  adminLoginChallenge,
  diagnosticsReport,
  forwardBundleDependency,
  forwardBundleAsset,
} from './schema.js';

export const adminSessionRelations = relations(adminSession, ({ one }) => ({
  admin: one(admin, {
    fields: [adminSession.adminId],
    references: [admin.id],
  }),
}));

export const adminRelations = relations(admin, ({ one, many }) => ({
  adminSessions: many(adminSession),
  user: one(user, {
    fields: [admin.userId],
    references: [user.id],
  }),
  adminActionLogs: many(adminActionLog),
  twoFactorBackupCodes: many(twoFactorBackupCode),
  webAuthnCredentials: many(webAuthnCredential),
  adminLoginChallenges: many(adminLoginChallenge),
}));

export const forwardMessageRelations = relations(forwardMessage, ({ one }) => ({
  forwardBundle: one(forwardBundle, {
    fields: [forwardMessage.bundleId],
    references: [forwardBundle.id],
  }),
  message: one(message, {
    fields: [forwardMessage.messageId],
    references: [message.id],
  }),
}));

export const forwardBundleRelations = relations(forwardBundle, ({ many }) => ({
  forwardMessages: many(forwardMessage),
  forwardBundleDependencies_childBundleId: many(forwardBundleDependency, {
    relationName: 'forwardBundleDependency_childBundleId_forwardBundle_id',
  }),
  forwardBundleDependencies_parentBundleId: many(forwardBundleDependency, {
    relationName: 'forwardBundleDependency_parentBundleId_forwardBundle_id',
  }),
  forwardBundleAssets: many(forwardBundleAsset),
}));

export const messageRelations = relations(message, ({ one, many }) => ({
  forwardMessages: many(forwardMessage),
  mediaMessages: many(mediaMessage),
  user: one(user, {
    fields: [message.creator],
    references: [user.id],
  }),
  messageThread: one(messageThread, {
    fields: [message.threadId],
    references: [messageThread.id],
  }),
}));

export const threadParticipantRelations = relations(
  threadParticipant,
  ({ one }) => ({
    messageThread: one(messageThread, {
      fields: [threadParticipant.threadId],
      references: [messageThread.id],
    }),
    user: one(user, {
      fields: [threadParticipant.userId],
      references: [user.id],
    }),
  }),
);

export const messageThreadRelations = relations(
  messageThread,
  ({ one, many }) => ({
    threadParticipants: many(threadParticipant),
    user: one(user, {
      fields: [messageThread.groupUserId],
      references: [user.id],
    }),
    mediaMessages: many(mediaMessage),
    messages: many(message),
    invites: many(invite),
    pendingMedias: many(pendingMedia),
    threadRevisions: many(threadRevision),
  }),
);

export const userRelations = relations(user, ({ one, many }) => ({
  threadParticipants: many(threadParticipant),
  messageThreads: many(messageThread),
  userBlocks_blockedId: many(userBlock, {
    relationName: 'userBlock_blockedId_user_id',
  }),
  userBlocks_blockerId: many(userBlock, {
    relationName: 'userBlock_blockerId_user_id',
  }),
  messages: many(message),
  admins: many(admin),
  pushTokens: many(pushToken),
  invites_fromUserId: many(invite, {
    relationName: 'invite_fromUserId_user_id',
  }),
  invites_toUserId: many(invite, {
    relationName: 'invite_toUserId_user_id',
  }),
  group: one(group, {
    fields: [user.id],
    references: [group.groupUserId],
  }),
  threadRevisions: many(threadRevision),
  loginCodes: many(loginCode),
  sessionTokens: many(sessionToken),
  diagnosticsReports: many(diagnosticsReport),
}));

export const mediaMessageRelations = relations(mediaMessage, ({ one }) => ({
  message: one(message, {
    fields: [mediaMessage.messageId],
    references: [message.id],
  }),
  messageThread: one(messageThread, {
    fields: [mediaMessage.threadId],
    references: [messageThread.id],
  }),
}));

export const userBlockRelations = relations(userBlock, ({ one }) => ({
  user_blockedId: one(user, {
    fields: [userBlock.blockedId],
    references: [user.id],
    relationName: 'userBlock_blockedId_user_id',
  }),
  user_blockerId: one(user, {
    fields: [userBlock.blockerId],
    references: [user.id],
    relationName: 'userBlock_blockerId_user_id',
  }),
}));

export const pushTokenRelations = relations(pushToken, ({ one }) => ({
  user: one(user, {
    fields: [pushToken.userId],
    references: [user.id],
  }),
}));

export const inviteRelations = relations(invite, ({ one }) => ({
  user_fromUserId: one(user, {
    fields: [invite.fromUserId],
    references: [user.id],
    relationName: 'invite_fromUserId_user_id',
  }),
  messageThread: one(messageThread, {
    fields: [invite.threadId],
    references: [messageThread.id],
  }),
  user_toUserId: one(user, {
    fields: [invite.toUserId],
    references: [user.id],
    relationName: 'invite_toUserId_user_id',
  }),
}));

export const adminActionLogRelations = relations(adminActionLog, ({ one }) => ({
  admin: one(admin, {
    fields: [adminActionLog.adminId],
    references: [admin.id],
  }),
}));

export const pendingMediaRelations = relations(pendingMedia, ({ one }) => ({
  messageThread: one(messageThread, {
    fields: [pendingMedia.threadId],
    references: [messageThread.id],
  }),
}));

export const groupRelations = relations(group, ({ one }) => ({
  user: one(user, {
    fields: [group.groupUserId],
    references: [user.id],
  }),
}));

export const threadRevisionRelations = relations(threadRevision, ({ one }) => ({
  messageThread: one(messageThread, {
    fields: [threadRevision.threadId],
    references: [messageThread.id],
  }),
  user: one(user, {
    fields: [threadRevision.userId],
    references: [user.id],
  }),
}));

export const loginCodeRelations = relations(loginCode, ({ one }) => ({
  user: one(user, {
    fields: [loginCode.userId],
    references: [user.id],
  }),
}));

export const sessionTokenRelations = relations(sessionToken, ({ one }) => ({
  user: one(user, {
    fields: [sessionToken.userId],
    references: [user.id],
  }),
}));

export const twoFactorBackupCodeRelations = relations(
  twoFactorBackupCode,
  ({ one }) => ({
    admin: one(admin, {
      fields: [twoFactorBackupCode.adminId],
      references: [admin.id],
    }),
  }),
);

export const webAuthnCredentialRelations = relations(
  webAuthnCredential,
  ({ one }) => ({
    admin: one(admin, {
      fields: [webAuthnCredential.adminId],
      references: [admin.id],
    }),
  }),
);

export const adminLoginChallengeRelations = relations(
  adminLoginChallenge,
  ({ one }) => ({
    admin: one(admin, {
      fields: [adminLoginChallenge.adminId],
      references: [admin.id],
    }),
  }),
);

export const diagnosticsReportRelations = relations(
  diagnosticsReport,
  ({ one }) => ({
    user: one(user, {
      fields: [diagnosticsReport.reporterUserId],
      references: [user.id],
    }),
  }),
);

export const forwardBundleDependencyRelations = relations(
  forwardBundleDependency,
  ({ one }) => ({
    forwardBundle_childBundleId: one(forwardBundle, {
      fields: [forwardBundleDependency.childBundleId],
      references: [forwardBundle.id],
      relationName: 'forwardBundleDependency_childBundleId_forwardBundle_id',
    }),
    forwardBundle_parentBundleId: one(forwardBundle, {
      fields: [forwardBundleDependency.parentBundleId],
      references: [forwardBundle.id],
      relationName: 'forwardBundleDependency_parentBundleId_forwardBundle_id',
    }),
  }),
);

export const forwardBundleAssetRelations = relations(
  forwardBundleAsset,
  ({ one }) => ({
    forwardBundle: one(forwardBundle, {
      fields: [forwardBundleAsset.bundleId],
      references: [forwardBundle.id],
    }),
  }),
);
