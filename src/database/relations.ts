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
  userPreference,
  messageAsset,
  pushToken,
  adminActionLog,
  pendingMedia,
  group,
  loginCode,
  sessionToken,
  twoFactorBackupCode,
  webAuthnCredential,
  adminLoginChallenge,
  diagnosticsReport,
  forwardBundleDependency,
  forwardBundleAsset,
  federatedPeer,
  peerStateFeed,
  peerStateFeedTarget,
  peerStateFeedPullCursor,
  relationshipIntent,
} from './schema.js';

export const federatedPeerRelations = relations(
  federatedPeer,
  ({ many, one }) => ({
    stateFeed: many(peerStateFeed),
    stateFeedTarget: one(peerStateFeedTarget),
    stateFeedPullCursor: one(peerStateFeedPullCursor),
  }),
);

export const peerStateFeedRelations = relations(peerStateFeed, ({ one }) => ({
  peer: one(federatedPeer, {
    fields: [peerStateFeed.peerDomain],
    references: [federatedPeer.domain],
  }),
}));

export const peerStateFeedTargetRelations = relations(
  peerStateFeedTarget,
  ({ one }) => ({
    peer: one(federatedPeer, {
      fields: [peerStateFeedTarget.peerDomain],
      references: [federatedPeer.domain],
    }),
  }),
);

export const peerStateFeedPullCursorRelations = relations(
  peerStateFeedPullCursor,
  ({ one }) => ({
    peer: one(federatedPeer, {
      fields: [peerStateFeedPullCursor.peerDomain],
      references: [federatedPeer.domain],
    }),
  }),
);

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
  messageAssets: many(messageAsset),
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
    messageAssets: many(messageAsset),
    messages: many(message),
    pendingMedias: many(pendingMedia),
  }),
);

export const userRelations = relations(user, ({ one, many }) => ({
  threadParticipants: many(threadParticipant),
  messageThreads: many(messageThread),
  messages: many(message),
  admins: many(admin),
  pushTokens: many(pushToken),
  authoredRelationshipIntents: many(relationshipIntent, {
    relationName: 'relationshipIntent_author',
  }),
  subjectRelationshipIntents: many(relationshipIntent, {
    relationName: 'relationshipIntent_subject',
  }),
  group: one(group, {
    fields: [user.id],
    references: [group.groupUserId],
  }),
  loginCodes: many(loginCode),
  sessionTokens: many(sessionToken),
  diagnosticsReports: many(diagnosticsReport),
  preferences: many(userPreference),
}));

export const userPreferenceRelations = relations(userPreference, ({ one }) => ({
  user: one(user, {
    fields: [userPreference.userId],
    references: [user.id],
  }),
}));

export const messageAssetRelations = relations(messageAsset, ({ one }) => ({
  message: one(message, {
    fields: [messageAsset.messageId],
    references: [message.id],
  }),
  messageThread: one(messageThread, {
    fields: [messageAsset.threadId],
    references: [messageThread.id],
  }),
}));

export const pushTokenRelations = relations(pushToken, ({ one }) => ({
  user: one(user, {
    fields: [pushToken.userId],
    references: [user.id],
  }),
}));

export const relationshipIntentRelations = relations(
  relationshipIntent,
  ({ one }) => ({
    author: one(user, {
      fields: [relationshipIntent.authorUserId],
      references: [user.id],
      relationName: 'relationshipIntent_author',
    }),
    subject: one(user, {
      fields: [relationshipIntent.subjectUserId],
      references: [user.id],
      relationName: 'relationshipIntent_subject',
    }),
  }),
);

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
