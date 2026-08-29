-- Namespace support is a clean-cut schema upgrade. Existing application data is intentionally
-- discarded: no legacy reset generation, tombstone, or identity projection is carried forward.
DO $$
DECLARE
  object_name text;
BEGIN
  FOR object_name IN
    SELECT quote_ident(tablename)
    FROM pg_tables
    WHERE schemaname = current_schema()
      AND tablename <> 'schema_migrations'
  LOOP
    EXECUTE 'DROP TABLE ' || object_name || ' CASCADE';
  END LOOP;

  FOR object_name IN
    SELECT quote_ident(t.typname)
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = current_schema()
      AND t.typtype = 'e'
  LOOP
    EXECUTE 'DROP TYPE ' || object_name || ' CASCADE';
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TYPE "public"."AdminRole" AS ENUM('SUPER_ADMIN', 'ADMIN', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."ContentType" AS ENUM('PURE_TEXT', 'IMAGE', 'VIDEO', 'FILE', 'AUDIO', 'LINK', 'CONTACT_CARD', 'CALL', 'FORWARD', 'GALLERY', 'SYSTEM');--> statement-breakpoint
CREATE TYPE "public"."FileSyncDirection" AS ENUM('OUTBOUND', 'INBOUND');--> statement-breakpoint
CREATE TYPE "public"."FileSyncKind" AS ENUM('FILE', 'IMAGE', 'VIDEO', 'AUDIO', 'LINK_CARD', 'BUNDLE');--> statement-breakpoint
CREATE TYPE "public"."FileSyncStatus" AS ENUM('PENDING', 'DOWNLOADING', 'SUCCEEDED', 'FAILED', 'TOMBSTONED');--> statement-breakpoint
CREATE TYPE "public"."GroupMetaMemberOperation" AS ENUM('UPSERT', 'DEPART');--> statement-breakpoint
CREATE TYPE "public"."GroupRole" AS ENUM('OWNER', 'ADMIN', 'MEMBER');--> statement-breakpoint
CREATE TYPE "public"."MessageDeleteType" AS ENUM('USER_RETRACTION', 'MODERATION_REMOVAL');--> statement-breakpoint
CREATE TYPE "public"."MessageLocalState" AS ENUM('STUB', 'FAILED', 'READY');--> statement-breakpoint
CREATE TYPE "public"."MessageReportStatus" AS ENUM('PENDING', 'UPHELD', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."MessageThreadType" AS ENUM('P2P', 'GROUP');--> statement-breakpoint
CREATE TYPE "public"."PeerStateEventType" AS ENUM('PROFILE', 'RELATIONSHIP_INTENT', 'GROUP_META_FEED_HEAD', 'THREAD_CONTENT_HEAD');--> statement-breakpoint
CREATE TYPE "public"."PushPlatform" AS ENUM('ANDROID', 'WEB', 'IOS');--> statement-breakpoint
CREATE TYPE "public"."RelationshipIntentStatus" AS ENUM('REQUESTED', 'ACCEPTED', 'REVOKED');--> statement-breakpoint
CREATE TYPE "public"."UploadSessionStatus" AS ENUM('UPLOADING', 'COMPLETING', 'COMPLETED', 'ABORTED');--> statement-breakpoint
CREATE TABLE "Account" (
	"id" integer PRIMARY KEY NOT NULL,
	"hashPwd" varchar(127),
	"mustChangePassword" boolean DEFAULT false NOT NULL,
	"disabledAt" timestamp (3) with time zone,
	"stateFeedAllocatedThrough" integer DEFAULT 0 NOT NULL,
	"readRevision" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Admin" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"lastLoginIp" varchar(64),
	"lastLoginAt" timestamp (3) with time zone,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone NOT NULL,
	"role" "AdminRole" DEFAULT 'SUPER_ADMIN' NOT NULL,
	"twoFactorEnabled" boolean DEFAULT false NOT NULL,
	"twoFactorSecretCipher" varchar(255),
	"twoFactorEnabledAt" timestamp (3) with time zone,
	"twoFactorLastUsedCounter" integer,
	"webauthnEnabled" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AdminActionLog" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"adminId" integer NOT NULL,
	"adminRole" "AdminRole" NOT NULL,
	"action" varchar(64) NOT NULL,
	"targetType" varchar(32),
	"targetId" varchar(64),
	"ip" varchar(64),
	"userAgent" varchar(255),
	"route" varchar(255),
	"success" boolean DEFAULT true NOT NULL,
	"errorMessage" varchar(255),
	"meta" jsonb,
	"at" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AdminLoginChallenge" (
	"jti" varchar(36) PRIMARY KEY NOT NULL,
	"adminId" integer NOT NULL,
	"consumedAt" timestamp (3) with time zone,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "AdminSession" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"adminId" integer NOT NULL,
	"tokenHash" text NOT NULL,
	"userAgent" varchar(255),
	"ip" varchar(64),
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"lastAccessedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expiresAt" timestamp (3) with time zone NOT NULL,
	"revokedAt" timestamp (3) with time zone,
	"revokeReason" varchar(32)
);
--> statement-breakpoint
CREATE TABLE "CallTombstone" (
	"peerDomain" varchar(253) NOT NULL,
	"namespaceId" integer NOT NULL,
	"callSid" varchar(36) NOT NULL,
	"terminalOp" varchar(16) NOT NULL,
	"endReason" varchar(16),
	"initialCallType" varchar(8) NOT NULL,
	"finalCallType" varchar(8) NOT NULL,
	"signalIds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expiresAt" timestamp (3) with time zone NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "CallTombstone_pkey" PRIMARY KEY("namespaceId","callSid")
);
--> statement-breakpoint
CREATE TABLE "ClientGroupMetaFeedTarget" (
	"accountId" integer NOT NULL,
	"groupId" integer NOT NULL,
	"allocatedThrough" bigint DEFAULT 0 NOT NULL,
	"oldestAvailableAfter" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ClientGroupMetaFeedTarget_pkey" PRIMARY KEY("accountId","groupId"),
	CONSTRAINT "ClientGroupMetaFeedTarget_allocatedThrough_check" CHECK ("ClientGroupMetaFeedTarget"."allocatedThrough" >= 0),
	CONSTRAINT "ClientGroupMetaFeedTarget_oldestAvailableAfter_check" CHECK ("ClientGroupMetaFeedTarget"."oldestAvailableAfter" >= 0 AND "ClientGroupMetaFeedTarget"."oldestAvailableAfter" <= "ClientGroupMetaFeedTarget"."allocatedThrough")
);
--> statement-breakpoint
CREATE TABLE "ClientGroupMetaMemberFeed" (
	"accountId" integer NOT NULL,
	"groupId" integer NOT NULL,
	"feedId" bigint NOT NULL,
	"memberAccount" varchar(31) NOT NULL,
	"memberDomain" varchar(63) NOT NULL,
	"memberNamespaceId" integer DEFAULT 0 NOT NULL,
	"operation" "GroupMetaMemberOperation" NOT NULL,
	"body" jsonb NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ClientGroupMetaMemberFeed_pkey" PRIMARY KEY("accountId","groupId","feedId"),
	CONSTRAINT "ClientGroupMetaMemberFeed_feedId_check" CHECK ("ClientGroupMetaMemberFeed"."feedId" > 0),
	CONSTRAINT "ClientGroupMetaMemberFeed_body_check" CHECK (("ClientGroupMetaMemberFeed"."operation" = 'UPSERT' AND "ClientGroupMetaMemberFeed"."body" <> '{}'::jsonb) OR ("ClientGroupMetaMemberFeed"."operation" = 'DEPART' AND "ClientGroupMetaMemberFeed"."body" = '{}'::jsonb))
);
--> statement-breakpoint
CREATE TABLE "ClientMessageFeed" (
	"userId" integer NOT NULL,
	"threadId" integer NOT NULL,
	"feedId" integer NOT NULL,
	"messageEndSeq" integer NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ClientMessageFeed_pkey" PRIMARY KEY("userId","threadId"),
	CONSTRAINT "ClientMessageFeed_feedId_check" CHECK ("ClientMessageFeed"."feedId" > 0),
	CONSTRAINT "ClientMessageFeed_messageEndSeq_check" CHECK ("ClientMessageFeed"."messageEndSeq" > 0)
);
--> statement-breakpoint
CREATE TABLE "ClientMessageFeedTarget" (
	"userId" integer PRIMARY KEY NOT NULL,
	"messageAllocatedThrough" integer DEFAULT 0 NOT NULL,
	"tombstoneAllocatedThrough" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ClientMessageFeedTarget_messageAllocatedThrough_check" CHECK ("ClientMessageFeedTarget"."messageAllocatedThrough" >= 0),
	CONSTRAINT "ClientMessageFeedTarget_tombstoneAllocatedThrough_check" CHECK ("ClientMessageFeedTarget"."tombstoneAllocatedThrough" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ClientMessageTombstoneFeed" (
	"userId" integer NOT NULL,
	"threadId" integer NOT NULL,
	"feedId" integer NOT NULL,
	"tombstoneEndSeq" integer NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ClientMessageTombstoneFeed_pkey" PRIMARY KEY("userId","threadId"),
	CONSTRAINT "ClientMessageTombstoneFeed_feedId_check" CHECK ("ClientMessageTombstoneFeed"."feedId" > 0),
	CONSTRAINT "ClientMessageTombstoneFeed_tombstoneEndSeq_check" CHECK ("ClientMessageTombstoneFeed"."tombstoneEndSeq" > 0)
);
--> statement-breakpoint
CREATE TABLE "ClientStateFeed" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"account" varchar(31) NOT NULL,
	"domain" varchar(63) NOT NULL,
	"eventType" varchar(31) NOT NULL,
	"subjectAccount" varchar(31) DEFAULT '' NOT NULL,
	"subjectDomain" varchar(63) DEFAULT 'local' NOT NULL,
	"namespaceId" integer DEFAULT 0 NOT NULL,
	"feedId" integer NOT NULL,
	"body" jsonb NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ClientStateFeed_compaction_key" UNIQUE("userId","account","domain","eventType","subjectAccount","subjectDomain","namespaceId"),
	CONSTRAINT "ClientStateFeed_feedId_check" CHECK ("ClientStateFeed"."feedId" > 0)
);
--> statement-breakpoint
CREATE TABLE "DeletedMessage" (
	"threadId" integer NOT NULL,
	"deletionSeq" integer NOT NULL,
	"messageSeq" integer NOT NULL,
	"type" "MessageDeleteType" NOT NULL,
	"federationSourceDomain" varchar(63),
	"sourceNamespaceId" integer,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "DeletedMessage_pkey" PRIMARY KEY("threadId","deletionSeq"),
	CONSTRAINT "DeletedMessage_deletionSeq_check" CHECK ("DeletedMessage"."deletionSeq" > 0),
	CONSTRAINT "DeletedMessage_messageSeq_check" CHECK ("DeletedMessage"."messageSeq" > 0)
);
--> statement-breakpoint
CREATE TABLE "DiagnosticsReport" (
	"id" serial PRIMARY KEY NOT NULL,
	"reporterUserId" integer NOT NULL,
	"bundlePath" varchar(255) NOT NULL,
	"bundleBytes" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone NOT NULL,
	"isDeleted" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "FederatedFriendRequest" (
	"localUserId" integer NOT NULL,
	"remoteAccount" varchar(31) NOT NULL,
	"remoteDomain" varchar(63) NOT NULL,
	"namespaceId" integer NOT NULL,
	"direction" varchar(16) NOT NULL,
	"status" varchar(16) NOT NULL,
	"note" varchar(255) DEFAULT '' NOT NULL,
	"requestedAt" timestamp (3) with time zone,
	"expiresAt" timestamp (3) with time zone,
	"displayName" varchar(30),
	"avatar" text,
	"profileRevision" integer,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "FederatedFriendRequest_pkey" PRIMARY KEY("localUserId","namespaceId","remoteAccount","direction"),
	CONSTRAINT "FederatedFriendRequest_direction_check" CHECK ("FederatedFriendRequest"."direction" IN ('INCOMING', 'OUTGOING')),
	CONSTRAINT "FederatedFriendRequest_status_check" CHECK ("FederatedFriendRequest"."status" IN ('REQUESTED', 'ACCEPTED', 'REVOKED')),
	CONSTRAINT "FederatedFriendRequest_profileRevision_check" CHECK ("FederatedFriendRequest"."profileRevision" IS NULL OR "FederatedFriendRequest"."profileRevision" >= 0),
	CONSTRAINT "FederatedFriendRequest_expiry_check" CHECK (("FederatedFriendRequest"."status" = 'REQUESTED' AND "FederatedFriendRequest"."requestedAt" IS NOT NULL AND "FederatedFriendRequest"."expiresAt" IS NOT NULL AND "FederatedFriendRequest"."expiresAt" > "FederatedFriendRequest"."requestedAt" AND "FederatedFriendRequest"."expiresAt" <= "FederatedFriendRequest"."requestedAt" + INTERVAL '7 days') OR ("FederatedFriendRequest"."status" = 'ACCEPTED' AND "FederatedFriendRequest"."requestedAt" IS NOT NULL AND "FederatedFriendRequest"."expiresAt" IS NULL) OR ("FederatedFriendRequest"."status" = 'REVOKED' AND "FederatedFriendRequest"."expiresAt" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "FederatedMessageTombstone" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"threadId" integer NOT NULL,
	"messageSeq" integer NOT NULL,
	"authorityDomain" varchar(255) NOT NULL,
	"sourceDomain" varchar(255) NOT NULL,
	"sourceNamespaceId" integer NOT NULL,
	"remoteDeletionSeq" integer NOT NULL,
	"type" "MessageDeleteType" NOT NULL,
	"authorityDeletedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "FederatedMessageTombstone_message_seq_check" CHECK ("FederatedMessageTombstone"."messageSeq" > 0),
	CONSTRAINT "FederatedMessageTombstone_remoteDeletionSeq_check" CHECK ("FederatedMessageTombstone"."remoteDeletionSeq" > 0)
);
--> statement-breakpoint
CREATE TABLE "FederatedPeer" (
	"domain" varchar(63) PRIMARY KEY NOT NULL,
	"activeNamespaceId" integer,
	"trustLevel" varchar(31) DEFAULT 'unrecognized' NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"trustedAt" timestamp (3) with time zone,
	"lastSuccessAt" timestamp (3) with time zone,
	"degradedAt" timestamp (3) with time zone,
	"degradationReason" varchar(255),
	"degradationCount" integer DEFAULT 0 NOT NULL,
	"haltedAt" timestamp (3) with time zone,
	"haltCode" integer,
	"haltReason" varchar(255),
	"dailyMsgLimit" integer,
	"dailyRequestLimit" integer,
	"dailyFileLimit" integer,
	"dailyFileBytesLimit" bigint,
	"recognizesPeer" boolean DEFAULT false NOT NULL,
	"outboundRecognitionConfirmed" boolean DEFAULT false NOT NULL,
	"inboundRecognitionConfirmed" boolean DEFAULT false NOT NULL,
	"lightweightInboundReady" boolean DEFAULT false NOT NULL,
	"localServiceAvailable" boolean DEFAULT false NOT NULL,
	"remoteServiceReachable" boolean DEFAULT false NOT NULL,
	"reverseRecognitionPending" boolean DEFAULT false NOT NULL,
	"outboundRecognizedAt" timestamp (3) with time zone,
	"inboundRecognizedAt" timestamp (3) with time zone,
	"resetAt" timestamp (3) with time zone,
	CONSTRAINT "FederatedPeer_trustLevel_check" CHECK ("FederatedPeer"."trustLevel" IN ('unrecognized', 'establishing', 'available', 'degraded', 'halted'))
);
--> statement-breakpoint
CREATE TABLE "FederatedPeerEvent" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"domain" varchar(63) NOT NULL,
	"type" varchar(15) NOT NULL,
	"reason" varchar(255),
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "FederationDeletedCursor" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"threadId" integer NOT NULL,
	"peerDomain" varchar(255) NOT NULL,
	"namespaceId" integer NOT NULL,
	"streamAccount" varchar(255) DEFAULT '' NOT NULL,
	"streamKind" varchar(32) NOT NULL,
	"committedThrough" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "FederationDeletedCursor_committedThrough_check" CHECK ("FederationDeletedCursor"."committedThrough" >= 0)
);
--> statement-breakpoint
CREATE TABLE "FederationMessageReceipt" (
	"peerDomain" varchar(63) NOT NULL,
	"namespaceId" integer NOT NULL,
	"threadId" integer NOT NULL,
	"peerSeq" integer NOT NULL,
	"messageId" bigint NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "FederationMessageReceipt_pkey" PRIMARY KEY("namespaceId","threadId","peerSeq"),
	CONSTRAINT "FederationMessageReceipt_peerSeq_check" CHECK ("FederationMessageReceipt"."peerSeq" > 0)
);
--> statement-breakpoint
CREATE TABLE "FederationThreadHistoryGap" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"threadId" integer NOT NULL,
	"namespaceId" integer NOT NULL,
	"startSeq" integer NOT NULL,
	"endSeq" integer NOT NULL,
	"recoverable" boolean DEFAULT true NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "FederationThreadHistoryGap_threadId_namespaceId_id_key" UNIQUE("threadId","namespaceId","id"),
	CONSTRAINT "FederationThreadHistoryGap_interval_check" CHECK ("FederationThreadHistoryGap"."startSeq" > 0 AND "FederationThreadHistoryGap"."endSeq" >= "FederationThreadHistoryGap"."startSeq")
);
--> statement-breakpoint
CREATE TABLE "FederationThreadSyncState" (
	"threadId" integer NOT NULL,
	"peerDomain" varchar(63) NOT NULL,
	"namespaceId" integer NOT NULL,
	"messageTargetSeq" integer DEFAULT 0 NOT NULL,
	"deletionTargetSeq" integer DEFAULT 0 NOT NULL,
	"messageProcessedThroughSeq" integer DEFAULT 0 NOT NULL,
	"deletionProcessedThroughSeq" integer DEFAULT 0 NOT NULL,
	"deletionRecoveryThroughSeq" integer,
	"deletionRecoveryMaxMessageSeq" integer,
	"authorizationEpoch" integer DEFAULT 0 NOT NULL,
	"activeGapId" bigint,
	"historyBoundaryReached" boolean DEFAULT false NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "FederationThreadSyncState_pkey" PRIMARY KEY("threadId","namespaceId"),
	CONSTRAINT "FederationThreadSyncState_messageSeqs_check" CHECK ("FederationThreadSyncState"."messageTargetSeq" >= 0
        AND "FederationThreadSyncState"."deletionTargetSeq" >= 0
        AND "FederationThreadSyncState"."messageProcessedThroughSeq" >= 0
        AND "FederationThreadSyncState"."deletionProcessedThroughSeq" >= 0
        AND "FederationThreadSyncState"."messageProcessedThroughSeq" <= "FederationThreadSyncState"."messageTargetSeq"
        AND "FederationThreadSyncState"."deletionProcessedThroughSeq" <= "FederationThreadSyncState"."deletionTargetSeq"
        AND "FederationThreadSyncState"."authorizationEpoch" >= 0),
	CONSTRAINT "FederationThreadSyncState_deletionRecovery_check" CHECK ((
          "FederationThreadSyncState"."deletionRecoveryThroughSeq" IS NULL
          AND "FederationThreadSyncState"."deletionRecoveryMaxMessageSeq" IS NULL
        ) OR (
          "FederationThreadSyncState"."deletionRecoveryThroughSeq" IS NOT NULL
          AND "FederationThreadSyncState"."deletionRecoveryMaxMessageSeq" IS NOT NULL
          AND "FederationThreadSyncState"."deletionRecoveryThroughSeq" > "FederationThreadSyncState"."deletionProcessedThroughSeq"
          AND "FederationThreadSyncState"."deletionRecoveryThroughSeq" <= "FederationThreadSyncState"."deletionTargetSeq"
          AND "FederationThreadSyncState"."deletionRecoveryMaxMessageSeq" >= 0
        )),
	CONSTRAINT "FederationThreadSyncState_history_check" CHECK (NOT ("FederationThreadSyncState"."historyBoundaryReached" AND "FederationThreadSyncState"."activeGapId" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "FileSyncProgress" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"batchId" uuid NOT NULL,
	"partId" uuid,
	"position" integer,
	"digest" varchar(64) NOT NULL,
	"direction" "FileSyncDirection" NOT NULL,
	"kind" "FileSyncKind" NOT NULL,
	"status" "FileSyncStatus" DEFAULT 'PENDING' NOT NULL,
	"bytesTotal" bigint DEFAULT 0 NOT NULL,
	"bytesReceived" bigint DEFAULT 0 NOT NULL,
	"originDomain" varchar(63),
	"namespaceId" integer DEFAULT 0 NOT NULL,
	"errorKind" varchar(255),
	"quotaCounted" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"payload" jsonb,
	CONSTRAINT "FileSyncProgress_position_check" CHECK ("FileSyncProgress"."position" IS NULL OR "FileSyncProgress"."position" BETWEEN 0 AND 9),
	CONSTRAINT "FileSyncProgress_outbound_part_check" CHECK ("FileSyncProgress"."direction" <> 'OUTBOUND' OR ("FileSyncProgress"."partId" IS NOT NULL AND "FileSyncProgress"."position" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "ForwardBundle" (
	"id" varchar(26) PRIMARY KEY NOT NULL,
	"messages" jsonb NOT NULL,
	"messageCount" integer NOT NULL,
	"assetCount" integer NOT NULL,
	"totalBytes" bigint NOT NULL,
	"sourceDomain" varchar(63),
	"sourceNamespaceId" integer,
	"sourceBundleId" varchar(26),
	"createdBy" integer,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ForwardBundle_asset_count_check" CHECK ("assetCount" >= 0),
	CONSTRAINT "ForwardBundle_messages_shape_check" CHECK (jsonb_typeof(messages) = 'array'::text),
	CONSTRAINT "ForwardBundle_message_count_check" CHECK (("messageCount" >= 0) AND ("messageCount" <= 500)),
	CONSTRAINT "ForwardBundle_total_bytes_check" CHECK ("totalBytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ForwardBundleAsset" (
	"bundleId" varchar(26) NOT NULL,
	"digest" varchar(64) NOT NULL,
	"ordinal" integer NOT NULL,
	"bytes" bigint NOT NULL,
	CONSTRAINT "ForwardBundleAsset_pkey" PRIMARY KEY("bundleId","ordinal")
);
--> statement-breakpoint
CREATE TABLE "ForwardBundleDependency" (
	"parentBundleId" varchar(26) NOT NULL,
	"childBundleId" varchar(26) NOT NULL,
	"ordinal" integer NOT NULL,
	CONSTRAINT "ForwardBundleDependency_pkey" PRIMARY KEY("parentBundleId","childBundleId")
);
--> statement-breakpoint
CREATE TABLE "ForwardMessage" (
	"messageId" bigint PRIMARY KEY NOT NULL,
	"bundleId" varchar(26) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Group" (
	"id" serial PRIMARY KEY NOT NULL,
	"account" varchar(31) NOT NULL,
	"domain" varchar(63) DEFAULT 'local' NOT NULL,
	"namespaceId" integer DEFAULT 0 NOT NULL,
	"name" varchar(30) NOT NULL,
	"avatar" text DEFAULT '' NOT NULL,
	"description" varchar(255) DEFAULT '' NOT NULL,
	"profileRev" integer DEFAULT 0 NOT NULL,
	"federationAuthorized" boolean DEFAULT false NOT NULL,
	"remoteGroupMetaFeedId" bigint,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone NOT NULL,
	"dissolvedAt" timestamp (3) with time zone,
	CONSTRAINT "Group_account_domain_namespaceId_key" UNIQUE("account","domain","namespaceId"),
	CONSTRAINT "Group_namespace_check" CHECK (("Group"."domain" = 'local') = ("Group"."namespaceId" = 0)),
	CONSTRAINT "Group_account_sigil_check" CHECK ("Group"."account" LIKE '!%'),
	CONSTRAINT "Group_profileRev_check" CHECK ("Group"."profileRev" >= 0),
	CONSTRAINT "Group_local_federationAuthorized_check" CHECK ("Group"."domain" <> 'local' OR "Group"."federationAuthorized" = false)
);
--> statement-breakpoint
CREATE TABLE "GroupAuditLog" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"eventKey" varchar(191) NOT NULL,
	"groupId" integer,
	"groupAccount" varchar(31) NOT NULL,
	"groupDomain" varchar(63) NOT NULL,
	"actorType" varchar(24) NOT NULL,
	"actorUserId" integer,
	"actorAccount" varchar(31) NOT NULL,
	"actorDomain" varchar(63) NOT NULL,
	"action" varchar(64) NOT NULL,
	"targetType" varchar(32),
	"targetId" varchar(191),
	"success" boolean DEFAULT true NOT NULL,
	"errorMessage" varchar(255),
	"meta" jsonb,
	"at" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "GroupMetaFeedTarget" (
	"targetPeerDomain" varchar(63) NOT NULL,
	"targetNamespaceId" integer NOT NULL,
	"groupId" integer NOT NULL,
	"allocatedThrough" bigint DEFAULT 0 NOT NULL,
	"oldestAvailableAfter" bigint DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "GroupMetaFeedTarget_pkey" PRIMARY KEY("targetNamespaceId","groupId"),
	CONSTRAINT "GroupMetaFeedTarget_allocatedThrough_check" CHECK ("GroupMetaFeedTarget"."allocatedThrough" >= 0),
	CONSTRAINT "GroupMetaFeedTarget_oldestAvailableAfter_check" CHECK ("GroupMetaFeedTarget"."oldestAvailableAfter" >= 0 AND "GroupMetaFeedTarget"."oldestAvailableAfter" <= "GroupMetaFeedTarget"."allocatedThrough")
);
--> statement-breakpoint
CREATE TABLE "GroupMetaMemberFeed" (
	"targetPeerDomain" varchar(63) NOT NULL,
	"targetNamespaceId" integer NOT NULL,
	"groupId" integer NOT NULL,
	"feedId" bigint NOT NULL,
	"memberAccount" varchar(31) NOT NULL,
	"memberDomain" varchar(63) NOT NULL,
	"memberNamespaceId" integer DEFAULT 0 NOT NULL,
	"operation" "GroupMetaMemberOperation" NOT NULL,
	"body" jsonb NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "GroupMetaMemberFeed_pkey" PRIMARY KEY("targetNamespaceId","groupId","feedId"),
	CONSTRAINT "GroupMetaMemberFeed_feedId_check" CHECK ("GroupMetaMemberFeed"."feedId" > 0),
	CONSTRAINT "GroupMetaMemberFeed_body_check" CHECK ("GroupMetaMemberFeed"."body" <> '{}'::jsonb)
);
--> statement-breakpoint
CREATE TABLE "GroupRequestProjection" (
	"managerUserId" integer NOT NULL,
	"threadId" integer NOT NULL,
	"memberUserId" integer NOT NULL,
	"direction" varchar(15) NOT NULL,
	"feedId" integer NOT NULL,
	"requestId" bigint NOT NULL,
	"status" varchar(15) NOT NULL,
	"note" varchar(255) DEFAULT '' NOT NULL,
	"requestedAt" timestamp (3) with time zone NOT NULL,
	"expiresAt" timestamp (3) with time zone NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "GroupRequestProjection_pkey" PRIMARY KEY("managerUserId","threadId","memberUserId","direction"),
	CONSTRAINT "GroupRequestProjection_feedId_check" CHECK ("GroupRequestProjection"."feedId" > 0),
	CONSTRAINT "GroupRequestProjection_direction_check" CHECK ("GroupRequestProjection"."direction" IN ('APPLICATION', 'INVITATION')),
	CONSTRAINT "GroupRequestProjection_status_check" CHECK ("GroupRequestProjection"."status" IN ('REQUESTED', 'ACCEPTED', 'REVOKED')),
	CONSTRAINT "GroupRequestProjection_retention_check" CHECK ("GroupRequestProjection"."expiresAt" > "GroupRequestProjection"."requestedAt" AND "GroupRequestProjection"."expiresAt" <= "GroupRequestProjection"."requestedAt" + INTERVAL '7 days')
);
--> statement-breakpoint
CREATE TABLE "IdentityNamespace" (
	"id" serial PRIMARY KEY NOT NULL,
	"domain" varchar(63) NOT NULL,
	"rootKeyFingerprint" varchar(80),
	"rootPublicKey" varchar(44),
	"identityPinnedAt" timestamp (3) with time zone,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"retiredAt" timestamp (3) with time zone,
	CONSTRAINT "IdentityNamespace_domain_id_key" UNIQUE("domain","id"),
	CONSTRAINT "IdentityNamespace_shape_check" CHECK ((
        "IdentityNamespace"."id" = 0
        AND "IdentityNamespace"."domain" = 'local'
        AND "IdentityNamespace"."rootKeyFingerprint" IS NULL
        AND "IdentityNamespace"."rootPublicKey" IS NULL
        AND "IdentityNamespace"."identityPinnedAt" IS NULL
        AND "IdentityNamespace"."retiredAt" IS NULL
      ) OR (
        "IdentityNamespace"."id" > 0
        AND "IdentityNamespace"."domain" <> 'local'
        AND "IdentityNamespace"."rootKeyFingerprint" IS NOT NULL
        AND "IdentityNamespace"."rootPublicKey" IS NOT NULL
        AND "IdentityNamespace"."identityPinnedAt" IS NOT NULL
      )),
	CONSTRAINT "IdentityNamespace_retiredAt_check" CHECK ("IdentityNamespace"."retiredAt" IS NULL OR "IdentityNamespace"."retiredAt" >= "IdentityNamespace"."createdAt")
);
--> statement-breakpoint
INSERT INTO "IdentityNamespace" ("id", "domain") VALUES (0, 'local');
--> statement-breakpoint
CREATE TABLE "LocalFederationIdentity" (
	"domain" varchar(63) PRIMARY KEY NOT NULL,
	"rootKeyFingerprint" varchar(80) NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "LoginCode" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"codeHash" varchar(127) NOT NULL,
	"issuedBy" integer NOT NULL,
	"issuedAt" timestamp (3) with time zone NOT NULL,
	"expiresAt" timestamp (3) with time zone NOT NULL,
	"consumedAt" timestamp (3) with time zone,
	"consumedIp" varchar(64),
	"consumedDevice" varchar(127),
	"producedSessionId" integer,
	"revokedAt" timestamp (3) with time zone
);
--> statement-breakpoint
CREATE TABLE "MediaAsset" (
	"digest" varchar(64) PRIMARY KEY NOT NULL,
	"bytes" bigint NOT NULL,
	"isDeleted" boolean DEFAULT false NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "Message" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"seq" integer NOT NULL,
	"contentType" "ContentType" NOT NULL,
	"content" jsonb NOT NULL,
	"threadId" integer NOT NULL,
	"creatorAccount" varchar(31),
	"creatorDomain" varchar(63),
	"creatorNamespaceId" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone NOT NULL,
	"isDeleted" boolean DEFAULT false NOT NULL,
	"clientMessageId" varchar(36),
	"originSeq" integer,
	"originServerTime" timestamp (3) with time zone,
	"federationSourceDomain" varchar(255),
	"sourceNamespaceId" integer,
	"localState" "MessageLocalState" DEFAULT 'READY' NOT NULL,
	CONSTRAINT "Message_seq_check" CHECK ("Message"."seq" > 0),
	CONSTRAINT "Message_system_creator_check" CHECK (("Message"."contentType" = 'SYSTEM' AND "Message"."creatorAccount" IS NULL AND "Message"."creatorDomain" IS NULL) OR ("Message"."contentType" <> 'SYSTEM' AND "Message"."creatorAccount" IS NOT NULL AND "Message"."creatorDomain" IS NOT NULL)),
	CONSTRAINT "Message_origin_seq_check" CHECK ("Message"."originSeq" IS NULL OR "Message"."originSeq" > 0)
);
--> statement-breakpoint
CREATE TABLE "MessageAsset" (
	"messageId" bigint NOT NULL,
	"threadId" integer NOT NULL,
	"digest" varchar(64) NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "MessageAsset_pkey" PRIMARY KEY("messageId","digest")
);
--> statement-breakpoint
CREATE TABLE "MessageReport" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"messageId" bigint NOT NULL,
	"threadId" integer NOT NULL,
	"messageSeq" integer NOT NULL,
	"reporterId" integer NOT NULL,
	"status" "MessageReportStatus" DEFAULT 'PENDING' NOT NULL,
	"reviewedByAdminId" integer,
	"reviewedAt" timestamp (3) with time zone,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "MessageThread" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" "MessageThreadType" NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone NOT NULL,
	"curSeq" integer DEFAULT 0 NOT NULL,
	"deletionSeqAllocatedThrough" integer DEFAULT 0 NOT NULL,
	"lastMessageSeq" integer,
	"lastMessagePreview" varchar(255),
	"lastMessageAt" timestamp (3) with time zone,
	"groupId" integer,
	"pullUntil" integer DEFAULT 0 NOT NULL,
	"authorityNamespaceId" integer DEFAULT 0 NOT NULL,
	"federationVersion" integer DEFAULT 0 NOT NULL,
	"authorizationEpoch" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "MessageThread_groupId_type_check" CHECK ((type = 'P2P'::"MessageThreadType") = ("groupId" IS NULL)),
	CONSTRAINT "MessageThread_federationVersion_check" CHECK ("MessageThread"."federationVersion" >= 0),
	CONSTRAINT "MessageThread_authorizationEpoch_check" CHECK ("MessageThread"."authorizationEpoch" >= 0),
	CONSTRAINT "MessageThread_deletionSeqAllocatedThrough_check" CHECK ("MessageThread"."deletionSeqAllocatedThrough" >= 0)
);
--> statement-breakpoint
CREATE TABLE "PeerStateFeed" (
	"peerDomain" varchar(63) NOT NULL,
	"namespaceId" integer NOT NULL,
	"account" varchar(31) NOT NULL,
	"domain" varchar(63) NOT NULL,
	"eventType" "PeerStateEventType" NOT NULL,
	"subjectAccount" varchar(31) DEFAULT '' NOT NULL,
	"subjectDomain" varchar(63) DEFAULT 'local' NOT NULL,
	"feedId" bigint NOT NULL,
	"body" jsonb NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "PeerStateFeed_pkey" PRIMARY KEY("namespaceId","account","domain","eventType","subjectAccount","subjectDomain"),
	CONSTRAINT "PeerStateFeed_feedId_check" CHECK ("PeerStateFeed"."feedId" > 0),
	CONSTRAINT "PeerStateFeed_subject_check" CHECK (("PeerStateFeed"."eventType" = 'RELATIONSHIP_INTENT' AND "PeerStateFeed"."subjectAccount" <> '' AND "PeerStateFeed"."subjectDomain" <> '')
        OR ("PeerStateFeed"."eventType" = 'THREAD_CONTENT_HEAD' AND (("PeerStateFeed"."account" LIKE '!%' AND "PeerStateFeed"."subjectAccount" = '' AND "PeerStateFeed"."subjectDomain" = 'local') OR ("PeerStateFeed"."account" NOT LIKE '!%' AND "PeerStateFeed"."subjectAccount" <> '' AND "PeerStateFeed"."subjectDomain" = "PeerStateFeed"."peerDomain")))
        OR ("PeerStateFeed"."eventType" NOT IN ('RELATIONSHIP_INTENT', 'THREAD_CONTENT_HEAD') AND "PeerStateFeed"."subjectAccount" = '' AND "PeerStateFeed"."subjectDomain" = 'local'))
);
--> statement-breakpoint
CREATE TABLE "PeerStateFeedPullCursor" (
	"peerDomain" varchar(63) NOT NULL,
	"namespaceId" integer PRIMARY KEY NOT NULL,
	"initialized" boolean DEFAULT false NOT NULL,
	"committedThrough" bigint DEFAULT 0 NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "PeerStateFeedPullCursor_committedThrough_check" CHECK ("PeerStateFeedPullCursor"."committedThrough" >= 0)
);
--> statement-breakpoint
CREATE TABLE "PeerStateFeedTarget" (
	"peerDomain" varchar(63) NOT NULL,
	"namespaceId" integer PRIMARY KEY NOT NULL,
	"allocatedThrough" bigint DEFAULT 0 NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "PeerStateFeedTarget_allocatedThrough_check" CHECK ("PeerStateFeedTarget"."allocatedThrough" >= 0)
);
--> statement-breakpoint
CREATE TABLE "PendingMedia" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"messageId" bigint,
	"threadId" integer,
	"creatorAccount" varchar(31),
	"creatorDomain" varchar(63),
	"contentType" "ContentType",
	"content" text,
	"digest" varchar(64),
	"clientMessageId" varchar(36),
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone NOT NULL,
	"failReason" varchar(255),
	"direction" "FileSyncDirection" DEFAULT 'OUTBOUND' NOT NULL,
	"batchId" uuid DEFAULT gen_random_uuid() NOT NULL,
	"fileCnt" integer DEFAULT 1 NOT NULL,
	"anyFailed" boolean DEFAULT false NOT NULL,
	"originDomain" varchar(63),
	"namespaceId" integer DEFAULT 0 NOT NULL,
	"expectedAuthorizationEpoch" integer,
	"dependsOnOriginSeq" integer,
	CONSTRAINT "PendingMedia_direction_shape_check" CHECK ((
          "PendingMedia"."direction" = 'OUTBOUND'
          AND "PendingMedia"."messageId" IS NULL
          AND "PendingMedia"."threadId" IS NOT NULL
          AND "PendingMedia"."creatorAccount" IS NOT NULL
          AND "PendingMedia"."creatorDomain" IS NOT NULL
          AND "PendingMedia"."contentType" IS NOT NULL
          AND "PendingMedia"."content" IS NOT NULL
          AND "PendingMedia"."originDomain" IS NULL
          AND "PendingMedia"."expectedAuthorizationEpoch" IS NULL
          AND "PendingMedia"."dependsOnOriginSeq" IS NULL
        ) OR (
          "PendingMedia"."direction" = 'INBOUND'
          AND "PendingMedia"."messageId" IS NOT NULL
          AND "PendingMedia"."threadId" IS NULL
          AND "PendingMedia"."creatorAccount" IS NULL
          AND "PendingMedia"."creatorDomain" IS NULL
          AND "PendingMedia"."contentType" IS NULL
          AND "PendingMedia"."content" IS NULL
          AND "PendingMedia"."clientMessageId" IS NULL
          AND "PendingMedia"."originDomain" IS NOT NULL
          AND "PendingMedia"."expectedAuthorizationEpoch" IS NOT NULL
        )),
	CONSTRAINT "PendingMedia_depends_on_origin_seq_check" CHECK ("PendingMedia"."dependsOnOriginSeq" IS NULL OR "PendingMedia"."dependsOnOriginSeq" > 0),
	CONSTRAINT "PendingMedia_expectedAuthorizationEpoch_check" CHECK ("PendingMedia"."expectedAuthorizationEpoch" IS NULL OR "PendingMedia"."expectedAuthorizationEpoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "PushToken" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"token" varchar(500) NOT NULL,
	"deviceId" varchar(127),
	"platform" "PushPlatform" NOT NULL,
	"webP256dh" varchar(255),
	"webAuth" varchar(255),
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone NOT NULL,
	"lastSeenAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "QuotaDailyAllowance" (
	"domain" varchar(63) NOT NULL,
	"date" date NOT NULL,
	"extraMsg" integer DEFAULT 0 NOT NULL,
	"extraFile" integer DEFAULT 0 NOT NULL,
	"extraFileBytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "QuotaDailyAllowance_pkey" PRIMARY KEY("domain","date")
);
--> statement-breakpoint
CREATE TABLE "QuotaDailyUsage" (
	"domain" varchar(63) NOT NULL,
	"date" date NOT NULL,
	"category" varchar(15) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "QuotaDailyUsage_pkey" PRIMARY KEY("domain","date","category")
);
--> statement-breakpoint
CREATE TABLE "QuotaFileByteUsage" (
	"domain" varchar(63) NOT NULL,
	"date" date NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "QuotaFileByteUsage_pkey" PRIMARY KEY("domain","date")
);
--> statement-breakpoint
CREATE TABLE "RelationshipIntent" (
	"id" bigserial NOT NULL,
	"pairId" bigint NOT NULL,
	"authorSide" varchar(1) NOT NULL,
	"status" "RelationshipIntentStatus" NOT NULL,
	"note" varchar(255) DEFAULT '' NOT NULL,
	"requestedAt" timestamp (3) with time zone,
	"expiresAt" timestamp (3) with time zone,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "RelationshipIntent_pkey" PRIMARY KEY("pairId","authorSide"),
	CONSTRAINT "RelationshipIntent_authorSide_check" CHECK ("RelationshipIntent"."authorSide" IN ('A', 'B')),
	CONSTRAINT "RelationshipIntent_expiry_check" CHECK (("RelationshipIntent"."status" = 'REQUESTED' AND "RelationshipIntent"."requestedAt" IS NOT NULL AND "RelationshipIntent"."expiresAt" IS NOT NULL AND "RelationshipIntent"."expiresAt" > "RelationshipIntent"."requestedAt" AND "RelationshipIntent"."expiresAt" <= "RelationshipIntent"."requestedAt" + INTERVAL '7 days') OR ("RelationshipIntent"."status" = 'ACCEPTED' AND "RelationshipIntent"."requestedAt" IS NOT NULL AND "RelationshipIntent"."expiresAt" IS NULL) OR ("RelationshipIntent"."status" = 'REVOKED' AND "RelationshipIntent"."expiresAt" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "RelationshipPair" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"kind" varchar(16) NOT NULL,
	"endpointAType" varchar(8) NOT NULL,
	"endpointAAccount" varchar(31) NOT NULL,
	"endpointADomain" varchar(63) NOT NULL,
	"endpointANamespaceId" integer DEFAULT 0 NOT NULL,
	"endpointBType" varchar(8) NOT NULL,
	"endpointBAccount" varchar(31) NOT NULL,
	"endpointBDomain" varchar(63) NOT NULL,
	"endpointBNamespaceId" integer DEFAULT 0 NOT NULL,
	"threadId" integer,
	"active" boolean DEFAULT false NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "RelationshipPair_endpoints_key" UNIQUE("endpointAType","endpointAAccount","endpointADomain","endpointANamespaceId","endpointBType","endpointBAccount","endpointBDomain","endpointBNamespaceId"),
	CONSTRAINT "RelationshipPair_kind_check" CHECK ("RelationshipPair"."kind" IN ('P2P', 'GROUP_MEMBER')),
	CONSTRAINT "RelationshipPair_endpoint_type_check" CHECK ("RelationshipPair"."endpointAType" IN ('USER', 'GROUP') AND "RelationshipPair"."endpointBType" IN ('USER', 'GROUP') AND (("RelationshipPair"."kind" = 'P2P' AND "RelationshipPair"."endpointAType" = 'USER' AND "RelationshipPair"."endpointBType" = 'USER') OR ("RelationshipPair"."kind" = 'GROUP_MEMBER' AND "RelationshipPair"."endpointAType" <> "RelationshipPair"."endpointBType"))),
	CONSTRAINT "RelationshipPair_distinct_endpoints_check" CHECK (("RelationshipPair"."endpointAType", "RelationshipPair"."endpointAAccount", "RelationshipPair"."endpointADomain") <> ("RelationshipPair"."endpointBType", "RelationshipPair"."endpointBAccount", "RelationshipPair"."endpointBDomain")),
	CONSTRAINT "RelationshipPair_revision_check" CHECK ("RelationshipPair"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "S2SKeyCache" (
	"domain" varchar(63) NOT NULL,
	"namespaceId" integer NOT NULL,
	"keyId" varchar(127) NOT NULL,
	"publicKey" varchar(127) NOT NULL,
	"notBefore" timestamp (3) with time zone NOT NULL,
	"notAfter" timestamp (3) with time zone NOT NULL,
	"authorizationSignature" varchar(127) NOT NULL,
	"fetchedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "S2SKeyCache_pkey" PRIMARY KEY("namespaceId","keyId")
);
--> statement-breakpoint
CREATE TABLE "SessionToken" (
	"id" serial PRIMARY KEY NOT NULL,
	"userId" integer NOT NULL,
	"tokenHash" varchar(127) NOT NULL,
	"device" varchar(127),
	"userAgent" varchar(255),
	"ip" varchar(64),
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"expiresAt" timestamp (3) with time zone NOT NULL,
	"lastSeenAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"revokedAt" timestamp (3) with time zone,
	"revokeReason" varchar(32),
	"client" varchar(16) NOT NULL,
	"lastSeenIp" varchar(64),
	"autoTerminateDays" integer DEFAULT 30 NOT NULL,
	CONSTRAINT "SessionToken_auto_terminate_days_check" CHECK ("SessionToken"."autoTerminateDays" IN (7, 30, 90, 180, 365))
);
--> statement-breakpoint
CREATE TABLE "SystemSetting" (
	"key" varchar(63) PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updatedAt" timestamp (3) with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ThreadAudience" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"targetDomain" varchar(63) NOT NULL,
	"targetNamespaceId" integer DEFAULT 0 NOT NULL,
	"localUserId" integer,
	"threadId" integer NOT NULL,
	"messageAccessAfterSeq" integer DEFAULT 0 NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ThreadAudience_target_check" CHECK (("ThreadAudience"."targetDomain" = 'local' AND "ThreadAudience"."localUserId" IS NOT NULL AND "ThreadAudience"."targetNamespaceId" = 0) OR ("ThreadAudience"."targetDomain" <> 'local' AND "ThreadAudience"."localUserId" IS NULL AND "ThreadAudience"."targetNamespaceId" > 0)),
	CONSTRAINT "ThreadAudience_messageAccessAfterSeq_check" CHECK ("ThreadAudience"."messageAccessAfterSeq" >= 0)
);
--> statement-breakpoint
CREATE TABLE "ThreadMember" (
	"id" serial PRIMARY KEY NOT NULL,
	"threadId" integer NOT NULL,
	"userId" integer NOT NULL,
	"role" "GroupRole",
	"left" boolean DEFAULT false NOT NULL,
	"firstSentSeq" integer,
	"lastSentSeq" integer,
	"joinedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ThreadMember_lastSentSeq_check" CHECK ("ThreadMember"."lastSentSeq" IS NULL OR "ThreadMember"."lastSentSeq" > 0),
	CONSTRAINT "ThreadMember_firstSentSeq_check" CHECK ("ThreadMember"."firstSentSeq" IS NULL OR "ThreadMember"."firstSentSeq" > 0)
);
--> statement-breakpoint
CREATE TABLE "ThreadParticipant" (
	"id" serial PRIMARY KEY NOT NULL,
	"accountId" integer NOT NULL,
	"threadId" integer NOT NULL,
	"role" "GroupRole",
	"lastReadSeq" integer,
	"readRevision" integer DEFAULT 0 NOT NULL,
	"muted" boolean DEFAULT false NOT NULL,
	"blocked" boolean DEFAULT false NOT NULL,
	"pinned" boolean DEFAULT false NOT NULL,
	"pinnedAt" timestamp (3) with time zone,
	"clearedSeq" integer,
	"messageVisibleBeforeSeq" bigint,
	"alias" varchar(64),
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "ThreadParticipant_cleared_seq_check" CHECK ("ThreadParticipant"."clearedSeq" IS NULL OR "ThreadParticipant"."clearedSeq" >= 0),
	CONSTRAINT "ThreadParticipant_messageVisibleBeforeSeq_check" CHECK ("ThreadParticipant"."messageVisibleBeforeSeq" IS NULL OR "ThreadParticipant"."messageVisibleBeforeSeq" > 1)
);
--> statement-breakpoint
CREATE TABLE "TwoFactorBackupCode" (
	"id" serial PRIMARY KEY NOT NULL,
	"adminId" integer NOT NULL,
	"codeHash" varchar(64) NOT NULL,
	"consumedAt" timestamp (3) with time zone,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "UploadSession" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"uploadId" uuid DEFAULT gen_random_uuid() NOT NULL,
	"clientMessageId" varchar(36) NOT NULL,
	"partId" uuid NOT NULL,
	"position" integer NOT NULL,
	"partIntent" "ContentType" NOT NULL,
	"creatorId" integer NOT NULL,
	"contentType" "ContentType" NOT NULL,
	"originalName" varchar(100) NOT NULL,
	"mimeType" varchar(255) NOT NULL,
	"totalBytes" bigint NOT NULL,
	"receivedBytes" bigint DEFAULT 0 NOT NULL,
	"status" "UploadSessionStatus" DEFAULT 'UPLOADING' NOT NULL,
	"tmpKey" uuid DEFAULT gen_random_uuid() NOT NULL,
	"digest" varchar(64),
	"result" jsonb,
	"errorReason" varchar(255),
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"completedAt" timestamp (3) with time zone,
	"abortedAt" timestamp (3) with time zone,
	CONSTRAINT "UploadSession_position_check" CHECK ("UploadSession"."position" BETWEEN 0 AND 9),
	CONSTRAINT "UploadSession_partIntent_check" CHECK ("UploadSession"."partIntent" <> 'GALLERY')
);
--> statement-breakpoint
CREATE TABLE "User" (
	"id" serial PRIMARY KEY NOT NULL,
	"account" varchar(31) NOT NULL,
	"name" text NOT NULL,
	"avatar" text DEFAULT '' NOT NULL,
	"bio" varchar(255) DEFAULT '' NOT NULL,
	"domain" varchar(63) DEFAULT 'local' NOT NULL,
	"sourceDomain" varchar(63) DEFAULT 'local' NOT NULL,
	"namespaceId" integer DEFAULT 0 NOT NULL,
	"availability" varchar(16) DEFAULT 'AVAILABLE' NOT NULL,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	"updatedAt" timestamp (3) with time zone NOT NULL,
	"profileRev" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "User_account_domain_sourceDomain_namespaceId_key" UNIQUE("account","domain","sourceDomain","namespaceId"),
	CONSTRAINT "User_namespace_check" CHECK (("User"."sourceDomain" = 'local') = ("User"."namespaceId" = 0)),
	CONSTRAINT "User_account_check" CHECK ("User"."account" NOT LIKE '!%'),
	CONSTRAINT "User_availability_check" CHECK ("User"."availability" IN ('AVAILABLE', 'REMOVED'))
);
--> statement-breakpoint
CREATE TABLE "UserPreference" (
	"userId" integer NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" jsonb NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "UserPreference_userId_key_pk" PRIMARY KEY("userId","key"),
	CONSTRAINT "UserPreference_value_not_json_null_check" CHECK ("UserPreference"."value" <> 'null'::jsonb),
	CONSTRAINT "UserPreference_revision_check" CHECK ("UserPreference"."revision" >= 0)
);
--> statement-breakpoint
CREATE TABLE "UserQuotaDailyAllowance" (
	"userId" integer NOT NULL,
	"date" date NOT NULL,
	"extraMsg" integer DEFAULT 0 NOT NULL,
	"extraFile" integer DEFAULT 0 NOT NULL,
	"extraFileBytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "UserQuotaDailyAllowance_pkey" PRIMARY KEY("userId","date")
);
--> statement-breakpoint
CREATE TABLE "UserQuotaDailyUsage" (
	"userId" integer NOT NULL,
	"date" date NOT NULL,
	"category" varchar(15) NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "UserQuotaDailyUsage_pkey" PRIMARY KEY("userId","date","category")
);
--> statement-breakpoint
CREATE TABLE "UserQuotaFileByteUsage" (
	"userId" integer NOT NULL,
	"date" date NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "UserQuotaFileByteUsage_pkey" PRIMARY KEY("userId","date")
);
--> statement-breakpoint
CREATE TABLE "UserQuotaPolicy" (
	"userId" integer PRIMARY KEY NOT NULL,
	"dailyMsgLimit" integer,
	"dailyRequestLimit" integer,
	"dailyFileLimit" integer,
	"dailyFileBytesLimit" bigint,
	"updatedAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE TABLE "WebAuthnCredential" (
	"id" serial PRIMARY KEY NOT NULL,
	"adminId" integer NOT NULL,
	"credentialId" varchar(510) NOT NULL,
	"publicKey" "bytea" NOT NULL,
	"counter" integer DEFAULT 0 NOT NULL,
	"transports" text,
	"deviceType" varchar(32),
	"backed" boolean DEFAULT false NOT NULL,
	"nickname" varchar(64),
	"lastUsedAt" timestamp (3) with time zone,
	"createdAt" timestamp (3) with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
ALTER TABLE "Account" ADD CONSTRAINT "Account_id_fkey" FOREIGN KEY ("id") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Admin" ADD CONSTRAINT "Admin_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AdminActionLog" ADD CONSTRAINT "AdminActionLog_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "public"."Admin"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AdminLoginChallenge" ADD CONSTRAINT "AdminLoginChallenge_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "public"."Admin"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "AdminSession" ADD CONSTRAINT "AdminSession_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "public"."Admin"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "CallTombstone" ADD CONSTRAINT "CallTombstone_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientGroupMetaFeedTarget" ADD CONSTRAINT "ClientGroupMetaFeedTarget_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientGroupMetaFeedTarget" ADD CONSTRAINT "ClientGroupMetaFeedTarget_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."Group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientGroupMetaMemberFeed" ADD CONSTRAINT "ClientGroupMetaMemberFeed_memberNamespaceId_fkey" FOREIGN KEY ("memberNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientGroupMetaMemberFeed" ADD CONSTRAINT "ClientGroupMetaMemberFeed_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientGroupMetaMemberFeed" ADD CONSTRAINT "ClientGroupMetaMemberFeed_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."Group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientMessageFeed" ADD CONSTRAINT "ClientMessageFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientMessageFeed" ADD CONSTRAINT "ClientMessageFeed_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientMessageFeedTarget" ADD CONSTRAINT "ClientMessageFeedTarget_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientMessageTombstoneFeed" ADD CONSTRAINT "ClientMessageTombstoneFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientMessageTombstoneFeed" ADD CONSTRAINT "ClientMessageTombstoneFeed_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientStateFeed" ADD CONSTRAINT "ClientStateFeed_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ClientStateFeed" ADD CONSTRAINT "ClientStateFeed_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DeletedMessage" ADD CONSTRAINT "DeletedMessage_sourceNamespaceId_fkey" FOREIGN KEY ("sourceNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "DeletedMessage" ADD CONSTRAINT "DeletedMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "DiagnosticsReport" ADD CONSTRAINT "DiagnosticsReport_reporterUserId_fkey" FOREIGN KEY ("reporterUserId") REFERENCES "public"."Account"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "FederatedFriendRequest" ADD CONSTRAINT "FederatedFriendRequest_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederatedFriendRequest" ADD CONSTRAINT "FederatedFriendRequest_namespace_fkey" FOREIGN KEY ("remoteDomain","namespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederatedMessageTombstone" ADD CONSTRAINT "FederatedMessageTombstone_sourceNamespaceId_fkey" FOREIGN KEY ("sourceNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederatedMessageTombstone" ADD CONSTRAINT "FederatedMessageTombstone_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "FederatedPeer" ADD CONSTRAINT "FederatedPeer_activeNamespace_fkey" FOREIGN KEY ("domain","activeNamespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederationDeletedCursor" ADD CONSTRAINT "FederationDeletedCursor_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederationDeletedCursor" ADD CONSTRAINT "FederationDeletedCursor_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "FederationMessageReceipt" ADD CONSTRAINT "FederationMessageReceipt_namespace_fkey" FOREIGN KEY ("peerDomain","namespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederationMessageReceipt" ADD CONSTRAINT "FederationMessageReceipt_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederationMessageReceipt" ADD CONSTRAINT "FederationMessageReceipt_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederationThreadHistoryGap" ADD CONSTRAINT "FederationThreadHistoryGap_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederationThreadHistoryGap" ADD CONSTRAINT "FederationThreadHistoryGap_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederationThreadSyncState" ADD CONSTRAINT "FederationThreadSyncState_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederationThreadSyncState" ADD CONSTRAINT "FederationThreadSyncState_namespace_fkey" FOREIGN KEY ("peerDomain","namespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FederationThreadSyncState" ADD CONSTRAINT "FederationThreadSyncState_activeGap_fkey" FOREIGN KEY ("threadId","namespaceId","activeGapId") REFERENCES "public"."FederationThreadHistoryGap"("threadId","namespaceId","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "FileSyncProgress" ADD CONSTRAINT "FileSyncProgress_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ForwardBundle" ADD CONSTRAINT "ForwardBundle_sourceNamespaceId_fkey" FOREIGN KEY ("sourceNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ForwardBundleAsset" ADD CONSTRAINT "ForwardBundleAsset_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "public"."ForwardBundle"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ForwardBundleDependency" ADD CONSTRAINT "ForwardBundleDependency_childBundleId_fkey" FOREIGN KEY ("childBundleId") REFERENCES "public"."ForwardBundle"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ForwardBundleDependency" ADD CONSTRAINT "ForwardBundleDependency_parentBundleId_fkey" FOREIGN KEY ("parentBundleId") REFERENCES "public"."ForwardBundle"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ForwardMessage" ADD CONSTRAINT "ForwardMessage_bundleId_fkey" FOREIGN KEY ("bundleId") REFERENCES "public"."ForwardBundle"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ForwardMessage" ADD CONSTRAINT "ForwardMessage_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Group" ADD CONSTRAINT "Group_namespace_fkey" FOREIGN KEY ("domain","namespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupMetaFeedTarget" ADD CONSTRAINT "GroupMetaFeedTarget_targetNamespace_fkey" FOREIGN KEY ("targetPeerDomain","targetNamespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupMetaFeedTarget" ADD CONSTRAINT "GroupMetaFeedTarget_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."Group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupMetaMemberFeed" ADD CONSTRAINT "GroupMetaMemberFeed_memberNamespaceId_fkey" FOREIGN KEY ("memberNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupMetaMemberFeed" ADD CONSTRAINT "GroupMetaMemberFeed_targetNamespace_fkey" FOREIGN KEY ("targetPeerDomain","targetNamespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupMetaMemberFeed" ADD CONSTRAINT "GroupMetaMemberFeed_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."Group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupRequestProjection" ADD CONSTRAINT "GroupRequestProjection_managerUserId_fkey" FOREIGN KEY ("managerUserId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupRequestProjection" ADD CONSTRAINT "GroupRequestProjection_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "GroupRequestProjection" ADD CONSTRAINT "GroupRequestProjection_memberUserId_fkey" FOREIGN KEY ("memberUserId") REFERENCES "public"."User"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "LoginCode" ADD CONSTRAINT "LoginCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "Message" ADD CONSTRAINT "Message_creatorNamespaceId_fkey" FOREIGN KEY ("creatorNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Message" ADD CONSTRAINT "Message_identityNamespace_fkey" FOREIGN KEY ("federationSourceDomain","sourceNamespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "Message" ADD CONSTRAINT "Message_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "MessageAsset" ADD CONSTRAINT "MessageAsset_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "MessageAsset" ADD CONSTRAINT "MessageAsset_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "public"."Account"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "MessageReport" ADD CONSTRAINT "MessageReport_reviewedByAdminId_fkey" FOREIGN KEY ("reviewedByAdminId") REFERENCES "public"."Admin"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "public"."Group"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "MessageThread" ADD CONSTRAINT "MessageThread_authorityNamespaceId_fkey" FOREIGN KEY ("authorityNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PeerStateFeed" ADD CONSTRAINT "PeerStateFeed_namespace_fkey" FOREIGN KEY ("peerDomain","namespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PeerStateFeedPullCursor" ADD CONSTRAINT "PeerStateFeedPullCursor_namespace_fkey" FOREIGN KEY ("peerDomain","namespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PeerStateFeedTarget" ADD CONSTRAINT "PeerStateFeedTarget_namespace_fkey" FOREIGN KEY ("peerDomain","namespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PendingMedia" ADD CONSTRAINT "PendingMedia_namespaceId_fkey" FOREIGN KEY ("namespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PendingMedia" ADD CONSTRAINT "PendingMedia_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "public"."Message"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "PendingMedia" ADD CONSTRAINT "PendingMedia_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "PushToken" ADD CONSTRAINT "PushToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "RelationshipIntent" ADD CONSTRAINT "RelationshipIntent_pairId_fkey" FOREIGN KEY ("pairId") REFERENCES "public"."RelationshipPair"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RelationshipPair" ADD CONSTRAINT "RelationshipPair_endpointANamespaceId_fkey" FOREIGN KEY ("endpointANamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RelationshipPair" ADD CONSTRAINT "RelationshipPair_endpointBNamespaceId_fkey" FOREIGN KEY ("endpointBNamespaceId") REFERENCES "public"."IdentityNamespace"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "RelationshipPair" ADD CONSTRAINT "RelationshipPair_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "S2SKeyCache" ADD CONSTRAINT "S2SKeyCache_namespace_fkey" FOREIGN KEY ("domain","namespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "SessionToken" ADD CONSTRAINT "SessionToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ThreadAudience" ADD CONSTRAINT "ThreadAudience_targetNamespace_fkey" FOREIGN KEY ("targetDomain","targetNamespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ThreadAudience" ADD CONSTRAINT "ThreadAudience_localUserId_fkey" FOREIGN KEY ("localUserId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ThreadAudience" ADD CONSTRAINT "ThreadAudience_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "ThreadMember" ADD CONSTRAINT "ThreadMember_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ThreadMember" ADD CONSTRAINT "ThreadMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."User"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ThreadParticipant" ADD CONSTRAINT "ThreadParticipant_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "public"."Account"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ThreadParticipant" ADD CONSTRAINT "ThreadParticipant_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "public"."MessageThread"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "TwoFactorBackupCode" ADD CONSTRAINT "TwoFactorBackupCode_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "public"."Admin"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_creatorId_fkey" FOREIGN KEY ("creatorId") REFERENCES "public"."Account"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "User" ADD CONSTRAINT "User_sourceNamespace_fkey" FOREIGN KEY ("sourceDomain","namespaceId") REFERENCES "public"."IdentityNamespace"("domain","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserPreference" ADD CONSTRAINT "UserPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "UserQuotaDailyAllowance" ADD CONSTRAINT "UserQuotaDailyAllowance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserQuotaDailyUsage" ADD CONSTRAINT "UserQuotaDailyUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserQuotaFileByteUsage" ADD CONSTRAINT "UserQuotaFileByteUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "UserQuotaPolicy" ADD CONSTRAINT "UserQuotaPolicy_userId_fkey" FOREIGN KEY ("userId") REFERENCES "public"."Account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "WebAuthnCredential" ADD CONSTRAINT "WebAuthnCredential_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "public"."Admin"("id") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "Admin_userId_key" ON "Admin" USING btree ("userId" int4_ops);--> statement-breakpoint
CREATE INDEX "AdminActionLog_action_idx" ON "AdminActionLog" USING btree ("action" text_ops);--> statement-breakpoint
CREATE INDEX "AdminActionLog_adminId_idx" ON "AdminActionLog" USING btree ("adminId" int4_ops);--> statement-breakpoint
CREATE INDEX "AdminActionLog_at_idx" ON "AdminActionLog" USING btree ("at" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "AdminLoginChallenge_createdAt_idx" ON "AdminLoginChallenge" USING btree ("createdAt" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "AdminSession_adminId_idx" ON "AdminSession" USING btree ("adminId" int4_ops);--> statement-breakpoint
CREATE INDEX "AdminSession_expiresAt_idx" ON "AdminSession" USING btree ("expiresAt" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "AdminSession_tokenHash_key" ON "AdminSession" USING btree ("tokenHash" text_ops);--> statement-breakpoint
CREATE INDEX "CallTombstone_expiresAt_idx" ON "CallTombstone" USING btree ("expiresAt");--> statement-breakpoint
CREATE INDEX "ClientGroupMetaMemberFeed_member_feed_idx" ON "ClientGroupMetaMemberFeed" USING btree ("accountId","groupId","memberDomain","memberNamespaceId","memberAccount","feedId");--> statement-breakpoint
CREATE UNIQUE INDEX "ClientMessageFeed_user_feedId_key" ON "ClientMessageFeed" USING btree ("userId","feedId");--> statement-breakpoint
CREATE UNIQUE INDEX "ClientMessageTombstoneFeed_user_feedId_key" ON "ClientMessageTombstoneFeed" USING btree ("userId","feedId");--> statement-breakpoint
CREATE INDEX "ClientStateFeed_user_feedId_idx" ON "ClientStateFeed" USING btree ("userId","feedId");--> statement-breakpoint
CREATE UNIQUE INDEX "DeletedMessage_threadId_messageSeq_key" ON "DeletedMessage" USING btree ("threadId" int4_ops,"messageSeq" int4_ops);--> statement-breakpoint
CREATE INDEX "DiagnosticsReport_createdAt_idx" ON "DiagnosticsReport" USING btree ("createdAt" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "DiagnosticsReport_reporterUserId_idx" ON "DiagnosticsReport" USING btree ("reporterUserId" int4_ops);--> statement-breakpoint
CREATE INDEX "DiagnosticsReport_status_idx" ON "DiagnosticsReport" USING btree ("status" text_ops);--> statement-breakpoint
CREATE INDEX "FederatedFriendRequest_pending_idx" ON "FederatedFriendRequest" USING btree ("localUserId","direction","status","expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "FederatedMessageTombstone_target_key" ON "FederatedMessageTombstone" USING btree ("threadId" int4_ops,"sourceNamespaceId" int4_ops,"messageSeq" int4_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "FederatedMessageTombstone_source_event_key" ON "FederatedMessageTombstone" USING btree ("sourceNamespaceId" int4_ops,"threadId" int4_ops,"remoteDeletionSeq" int4_ops);--> statement-breakpoint
CREATE INDEX "FederatedPeer_lastSuccessAt_idx" ON "FederatedPeer" USING btree ("lastSuccessAt" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "FederatedPeer_trustLevel_idx" ON "FederatedPeer" USING btree ("trustLevel" text_ops);--> statement-breakpoint
CREATE INDEX "FederatedPeerEvent_createdAt_idx" ON "FederatedPeerEvent" USING btree ("createdAt" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "FederatedPeerEvent_domain_createdAt_idx" ON "FederatedPeerEvent" USING btree ("domain" text_ops,"createdAt" timestamptz_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "FederationDeletedCursor_stream_key" ON "FederationDeletedCursor" USING btree ("threadId" int4_ops,"namespaceId" int4_ops,"streamAccount" text_ops,"streamKind" text_ops);--> statement-breakpoint
CREATE INDEX "FederationMessageReceipt_messageId_idx" ON "FederationMessageReceipt" USING btree ("messageId");--> statement-breakpoint
CREATE UNIQUE INDEX "FederationThreadHistoryGap_interval_key" ON "FederationThreadHistoryGap" USING btree ("threadId","namespaceId","startSeq","endSeq");--> statement-breakpoint
CREATE INDEX "FederationThreadHistoryGap_recoverable_idx" ON "FederationThreadHistoryGap" USING btree ("threadId","namespaceId","endSeq") WHERE "FederationThreadHistoryGap"."recoverable" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "FileSyncProgress_batchId_partId_key" ON "FileSyncProgress" USING btree ("batchId","partId") WHERE "FileSyncProgress"."partId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "FileSyncProgress_batchId_position_key" ON "FileSyncProgress" USING btree ("batchId","position") WHERE "FileSyncProgress"."position" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "FileSyncProgress_batchId_digest_idx" ON "FileSyncProgress" USING btree ("batchId","digest");--> statement-breakpoint
CREATE INDEX "FileSyncProgress_digest_idx" ON "FileSyncProgress" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "FileSyncProgress_status_updatedAt_idx" ON "FileSyncProgress" USING btree ("status","updatedAt");--> statement-breakpoint
CREATE INDEX "ForwardBundle_createdBy_idx" ON "ForwardBundle" USING btree ("createdBy" int4_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ForwardBundle_sourceNamespace_sourceBundleId_key" ON "ForwardBundle" USING btree ("sourceNamespaceId" int4_ops,"sourceBundleId" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ForwardBundleAsset_bundleId_digest_key" ON "ForwardBundleAsset" USING btree ("bundleId" text_ops,"digest" text_ops);--> statement-breakpoint
CREATE INDEX "ForwardBundleAsset_digest_idx" ON "ForwardBundleAsset" USING btree ("digest" text_ops);--> statement-breakpoint
CREATE INDEX "ForwardBundleDependency_childBundleId_idx" ON "ForwardBundleDependency" USING btree ("childBundleId" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "ForwardBundleDependency_parentBundleId_ordinal_key" ON "ForwardBundleDependency" USING btree ("parentBundleId" text_ops,"ordinal" int4_ops);--> statement-breakpoint
CREATE INDEX "ForwardMessage_bundleId_idx" ON "ForwardMessage" USING btree ("bundleId" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "GroupAuditLog_eventKey_key" ON "GroupAuditLog" USING btree ("eventKey");--> statement-breakpoint
CREATE INDEX "GroupAuditLog_groupId_at_idx" ON "GroupAuditLog" USING btree ("groupId","at");--> statement-breakpoint
CREATE INDEX "GroupAuditLog_action_at_idx" ON "GroupAuditLog" USING btree ("action","at");--> statement-breakpoint
CREATE INDEX "GroupMetaMemberFeed_member_feed_idx" ON "GroupMetaMemberFeed" USING btree ("targetPeerDomain","targetNamespaceId","groupId","memberDomain","memberNamespaceId","memberAccount","feedId");--> statement-breakpoint
CREATE UNIQUE INDEX "GroupRequestProjection_manager_feed_key" ON "GroupRequestProjection" USING btree ("managerUserId","feedId");--> statement-breakpoint
CREATE INDEX "GroupRequestProjection_thread_feed_idx" ON "GroupRequestProjection" USING btree ("managerUserId","threadId","feedId");--> statement-breakpoint
CREATE INDEX "GroupRequestProjection_expiry_idx" ON "GroupRequestProjection" USING btree ("expiresAt");--> statement-breakpoint
CREATE UNIQUE INDEX "IdentityNamespace_one_live_per_domain_key" ON "IdentityNamespace" USING btree ("domain") WHERE "IdentityNamespace"."id" > 0 AND "IdentityNamespace"."retiredAt" IS NULL;--> statement-breakpoint
CREATE INDEX "LoginCode_userId_idx" ON "LoginCode" USING btree ("userId" int4_ops);--> statement-breakpoint
CREATE INDEX "MediaAsset_isDeleted_idx" ON "MediaAsset" USING btree ("isDeleted" bool_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "Message_clientMessageId_key" ON "Message" USING btree ("clientMessageId" text_ops);--> statement-breakpoint
CREATE INDEX "Message_createdAt_idx" ON "Message" USING btree ("createdAt" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "Message_creator_address_idx" ON "Message" USING btree ("creatorAccount" text_ops,"creatorDomain" text_ops,"creatorNamespaceId" int4_ops);--> statement-breakpoint
CREATE INDEX "Message_threadId_createdAt_idx" ON "Message" USING btree ("threadId" int4_ops,"createdAt" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "Message_threadId_id_idx" ON "Message" USING btree ("threadId" int4_ops,"id" int8_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "Message_threadId_creator_originSeq_key" ON "Message" USING btree ("threadId" int4_ops,"creatorAccount" text_ops,"creatorDomain" text_ops,"creatorNamespaceId" int4_ops,"originSeq" int4_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "Message_threadId_source_originSeq_key" ON "Message" USING btree ("threadId" int4_ops,"sourceNamespaceId" int4_ops,"originSeq" int4_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "Message_threadId_seq_key" ON "Message" USING btree ("threadId" int4_ops,"seq" int4_ops);--> statement-breakpoint
CREATE INDEX "Message_threadId_ready_seq_idx" ON "Message" USING btree ("threadId","seq") WHERE "Message"."localState" = 'READY';--> statement-breakpoint
CREATE INDEX "MessageAsset_digest_idx" ON "MessageAsset" USING btree ("digest" text_ops);--> statement-breakpoint
CREATE INDEX "MessageAsset_threadId_idx" ON "MessageAsset" USING btree ("threadId" int4_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "MessageReport_reporterId_messageId_key" ON "MessageReport" USING btree ("reporterId" int4_ops,"messageId" int8_ops);--> statement-breakpoint
CREATE INDEX "MessageReport_status_createdAt_idx" ON "MessageReport" USING btree ("status" enum_ops,"createdAt" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "MessageReport_messageId_idx" ON "MessageReport" USING btree ("messageId" int8_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "MessageThread_groupId_key" ON "MessageThread" USING btree ("groupId" int4_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "PeerStateFeed_peerDomain_feedId_key" ON "PeerStateFeed" USING btree ("namespaceId","feedId");--> statement-breakpoint
CREATE INDEX "PendingMedia_batchId_idx" ON "PendingMedia" USING btree ("batchId");--> statement-breakpoint
CREATE UNIQUE INDEX "PendingMedia_messageId_key" ON "PendingMedia" USING btree ("messageId") WHERE "PendingMedia"."messageId" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "PendingMedia_clientMessageId_key" ON "PendingMedia" USING btree ("clientMessageId" text_ops);--> statement-breakpoint
CREATE INDEX "PendingMedia_status_createdAt_idx" ON "PendingMedia" USING btree ("status" text_ops,"createdAt" timestamptz_ops);--> statement-breakpoint
CREATE INDEX "PendingMedia_threadId_idx" ON "PendingMedia" USING btree ("threadId" int4_ops);--> statement-breakpoint
CREATE INDEX "PendingMedia_quote_dependency_idx" ON "PendingMedia" USING btree ("threadId","originDomain","dependsOnOriginSeq");--> statement-breakpoint
CREATE UNIQUE INDEX "PushToken_token_key" ON "PushToken" USING btree ("token" text_ops);--> statement-breakpoint
CREATE INDEX "PushToken_userId_idx" ON "PushToken" USING btree ("userId" int4_ops);--> statement-breakpoint
CREATE INDEX "QuotaDailyUsage_date_idx" ON "QuotaDailyUsage" USING btree ("date" date_ops);--> statement-breakpoint
CREATE INDEX "QuotaFileByteUsage_date_idx" ON "QuotaFileByteUsage" USING btree ("date" date_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "RelationshipIntent_id_key" ON "RelationshipIntent" USING btree ("id");--> statement-breakpoint
CREATE INDEX "RelationshipPair_endpointA_idx" ON "RelationshipPair" USING btree ("endpointAType","endpointAAccount","endpointADomain","endpointANamespaceId","active");--> statement-breakpoint
CREATE INDEX "RelationshipPair_endpointB_idx" ON "RelationshipPair" USING btree ("endpointBType","endpointBAccount","endpointBDomain","endpointBNamespaceId","active");--> statement-breakpoint
CREATE INDEX "SessionToken_lastSeenAt_active_idx" ON "SessionToken" USING btree ("lastSeenAt" timestamptz_ops) WHERE ("revokedAt" IS NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "SessionToken_tokenHash_key" ON "SessionToken" USING btree ("tokenHash" text_ops);--> statement-breakpoint
CREATE INDEX "SessionToken_userId_idx" ON "SessionToken" USING btree ("userId" int4_ops);--> statement-breakpoint
CREATE INDEX "SessionToken_userId_lastSeenAt_active_idx" ON "SessionToken" USING btree ("userId" int4_ops,"lastSeenAt" timestamptz_ops) WHERE ("revokedAt" IS NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "ThreadAudience_local_key" ON "ThreadAudience" USING btree ("targetDomain" text_ops,"localUserId" int4_ops,"threadId" int4_ops) WHERE "ThreadAudience"."targetDomain" = 'local';--> statement-breakpoint
CREATE UNIQUE INDEX "ThreadAudience_peer_key" ON "ThreadAudience" USING btree ("targetNamespaceId" int4_ops,"threadId" int4_ops) WHERE "ThreadAudience"."targetDomain" <> 'local';--> statement-breakpoint
CREATE INDEX "ThreadAudience_local_access_idx" ON "ThreadAudience" USING btree ("localUserId" int4_ops,"threadId" int4_ops) WHERE "ThreadAudience"."targetDomain" = 'local';--> statement-breakpoint
CREATE INDEX "ThreadAudience_peer_access_idx" ON "ThreadAudience" USING btree ("targetNamespaceId" int4_ops,"threadId" int4_ops) WHERE "ThreadAudience"."targetDomain" <> 'local';--> statement-breakpoint
CREATE UNIQUE INDEX "ThreadMember_threadId_userId_key" ON "ThreadMember" USING btree ("threadId","userId");--> statement-breakpoint
CREATE UNIQUE INDEX "ThreadMember_id_threadId_key" ON "ThreadMember" USING btree ("id","threadId");--> statement-breakpoint
CREATE INDEX "ThreadMember_threadId_left_lastSentSeq_idx" ON "ThreadMember" USING btree ("threadId","left","lastSentSeq");--> statement-breakpoint
CREATE INDEX "ThreadMember_threadId_left_firstSentSeq_idx" ON "ThreadMember" USING btree ("threadId","left","firstSentSeq");--> statement-breakpoint
CREATE UNIQUE INDEX "ThreadMember_one_current_owner_key" ON "ThreadMember" USING btree ("threadId") WHERE "ThreadMember"."role" = 'OWNER' AND "ThreadMember"."left" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "ThreadParticipant_accountId_threadId_key" ON "ThreadParticipant" USING btree ("accountId","threadId");--> statement-breakpoint
CREATE INDEX "ThreadParticipant_threadId_idx" ON "ThreadParticipant" USING btree ("threadId");--> statement-breakpoint
CREATE INDEX "ThreadParticipant_accountId_pinned_idx" ON "ThreadParticipant" USING btree ("accountId","pinned");--> statement-breakpoint
CREATE INDEX "ThreadParticipant_accountId_readRevision_idx" ON "ThreadParticipant" USING btree ("accountId","readRevision");--> statement-breakpoint
CREATE INDEX "TwoFactorBackupCode_adminId_codeHash_idx" ON "TwoFactorBackupCode" USING btree ("adminId" int4_ops,"codeHash" text_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "UploadSession_uploadId_key" ON "UploadSession" USING btree ("uploadId");--> statement-breakpoint
CREATE UNIQUE INDEX "UploadSession_clientMessageId_partId_key" ON "UploadSession" USING btree ("clientMessageId","partId");--> statement-breakpoint
CREATE UNIQUE INDEX "UploadSession_clientMessageId_position_key" ON "UploadSession" USING btree ("clientMessageId","position");--> statement-breakpoint
CREATE INDEX "UploadSession_creatorId_status_idx" ON "UploadSession" USING btree ("creatorId","status");--> statement-breakpoint
CREATE INDEX "UploadSession_status_updatedAt_idx" ON "UploadSession" USING btree ("status","updatedAt");--> statement-breakpoint
CREATE INDEX "UploadSession_digest_idx" ON "UploadSession" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "User_address_idx" ON "User" USING btree ("account","domain");--> statement-breakpoint
CREATE INDEX "User_source_address_idx" ON "User" USING btree ("sourceDomain","namespaceId","account","domain");--> statement-breakpoint
CREATE INDEX "UserQuotaDailyUsage_date_idx" ON "UserQuotaDailyUsage" USING btree ("date" date_ops);--> statement-breakpoint
CREATE INDEX "UserQuotaFileByteUsage_date_idx" ON "UserQuotaFileByteUsage" USING btree ("date" date_ops);--> statement-breakpoint
CREATE INDEX "WebAuthnCredential_adminId_idx" ON "WebAuthnCredential" USING btree ("adminId" int4_ops);--> statement-breakpoint
CREATE UNIQUE INDEX "WebAuthnCredential_credentialId_key" ON "WebAuthnCredential" USING btree ("credentialId" text_ops);
