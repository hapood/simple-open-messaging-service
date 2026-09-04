import { relations } from 'drizzle-orm/relations';
import {
  admin,
  account,
  adminSession,
  forwardBundle,
  forwardMessage,
  message,
  messageThread,
  accountThreadState,
  user,
  userPreference,
  messageAsset,
  pushToken,
  adminActionLog,
  pendingMedia,
  group,
  groupMetaFeed,
  groupMetaMemberFeed,
  groupMetaProfileFeed,
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
  relationshipPair,
  federationThreadHistoryGap,
  federationThreadSyncState,
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
  account: one(account, {
    fields: [admin.userId],
    references: [account.id],
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
  messageThread: one(messageThread, {
    fields: [message.threadId],
    references: [messageThread.id],
  }),
  inboundPendingMedia: one(pendingMedia),
}));

export const accountThreadStateRelations = relations(
  accountThreadState,
  ({ one }) => ({
    account: one(account, {
      fields: [accountThreadState.accountId],
      references: [account.id],
    }),
    messageThread: one(messageThread, {
      fields: [accountThreadState.threadId],
      references: [messageThread.id],
    }),
  }),
);

export const messageThreadRelations = relations(
  messageThread,
  ({ one, many }) => ({
    accountThreadStates: many(accountThreadState),
    group: one(group, {
      fields: [messageThread.groupId],
      references: [group.id],
    }),
    messageAssets: many(messageAsset),
    messages: many(message),
    pendingMedias: many(pendingMedia),
    federationHistoryGaps: many(federationThreadHistoryGap),
    federationSyncStates: many(federationThreadSyncState),
  }),
);

export const userRelations = relations(user, ({ one, many }) => ({
  account: one(account),
  admins: many(admin),
}));

export const accountRelations = relations(account, ({ one, many }) => ({
  user: one(user, {
    fields: [account.id],
    references: [user.id],
  }),
  admins: many(admin),
  pushTokens: many(pushToken),
  loginCodes: many(loginCode),
  sessionTokens: many(sessionToken),
  diagnosticsReports: many(diagnosticsReport),
  preferences: many(userPreference),
}));

export const userPreferenceRelations = relations(userPreference, ({ one }) => ({
  account: one(account, {
    fields: [userPreference.userId],
    references: [account.id],
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
  account: one(account, {
    fields: [pushToken.userId],
    references: [account.id],
  }),
  session: one(sessionToken, {
    fields: [pushToken.sessionId],
    references: [sessionToken.id],
  }),
}));

export const relationshipIntentRelations = relations(
  relationshipIntent,
  ({ one }) => ({
    pair: one(relationshipPair, {
      fields: [relationshipIntent.pairId],
      references: [relationshipPair.id],
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
  message: one(message, {
    fields: [pendingMedia.messageId],
    references: [message.id],
  }),
  messageThread: one(messageThread, {
    fields: [pendingMedia.threadId],
    references: [messageThread.id],
  }),
}));

export const federationThreadHistoryGapRelations = relations(
  federationThreadHistoryGap,
  ({ one }) => ({
    messageThread: one(messageThread, {
      fields: [federationThreadHistoryGap.threadId],
      references: [messageThread.id],
    }),
  }),
);

export const federationThreadSyncStateRelations = relations(
  federationThreadSyncState,
  ({ one }) => ({
    messageThread: one(messageThread, {
      fields: [federationThreadSyncState.threadId],
      references: [messageThread.id],
    }),
    activeGap: one(federationThreadHistoryGap, {
      fields: [
        federationThreadSyncState.threadId,
        federationThreadSyncState.activeGapId,
      ],
      references: [
        federationThreadHistoryGap.threadId,
        federationThreadHistoryGap.id,
      ],
    }),
  }),
);

export const groupRelations = relations(group, ({ one, many }) => ({
  messageThread: one(messageThread),
  metaFeed: one(groupMetaFeed),
  metaProfile: one(groupMetaProfileFeed),
  metaMembers: many(groupMetaMemberFeed),
}));

export const groupMetaFeedRelations = relations(groupMetaFeed, ({ one }) => ({
  group: one(group, {
    fields: [groupMetaFeed.groupId],
    references: [group.id],
  }),
}));

export const groupMetaMemberFeedRelations = relations(
  groupMetaMemberFeed,
  ({ one }) => ({
    group: one(group, {
      fields: [groupMetaMemberFeed.groupId],
      references: [group.id],
    }),
  }),
);

export const groupMetaProfileFeedRelations = relations(
  groupMetaProfileFeed,
  ({ one }) => ({
    group: one(group, {
      fields: [groupMetaProfileFeed.groupId],
      references: [group.id],
    }),
  }),
);

export const loginCodeRelations = relations(loginCode, ({ one }) => ({
  account: one(account, {
    fields: [loginCode.userId],
    references: [account.id],
  }),
}));

export const sessionTokenRelations = relations(
  sessionToken,
  ({ one, many }) => ({
    account: one(account, {
      fields: [sessionToken.userId],
      references: [account.id],
    }),
    pushTokens: many(pushToken),
  }),
);

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
    account: one(account, {
      fields: [diagnosticsReport.reporterUserId],
      references: [account.id],
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
