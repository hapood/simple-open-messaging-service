import {
  pgTable,
  index,
  uniqueIndex,
  foreignKey,
  bigserial,
  integer,
  text,
  varchar,
  timestamp,
  bigint,
  check,
  jsonb,
  serial,
  boolean,
  primaryKey,
  date,
  pgEnum,
  uuid,
  customType,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import {
  RequestProjectionStatus,
  type RequestProjectionStatusValue,
} from '../../shared/request-projection-status.js';

const bytea = customType<{ data: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Store the wire-format JSON string as PostgreSQL jsonb while permanently
 * keeping service and transport boundaries string-based. PostgreSQL's binary
 * jsonb representation never leaks into HTTP, SSE, or federation payloads.
 */
const jsonbText = customType<{ data: string; driverData: unknown }>({
  dataType: () => 'jsonb',
  toDriver: (value) => JSON.parse(value) as unknown,
  fromDriver: (value) => JSON.stringify(value),
});

export const adminRole = pgEnum('AdminRole', [
  'SUPER_ADMIN',
  'ADMIN',
  'VIEWER',
]);
export const adminAuditStatus = pgEnum('AdminAuditStatus', [
  'STARTED',
  'SUCCEEDED',
  'FAILED',
]);
export const contentType = pgEnum('ContentType', [
  'PURE_TEXT',
  'IMAGE',
  'VIDEO',
  'FILE',
  'AUDIO',
  'LINK',
  'CONTACT_CARD',
  'FORWARD',
  // Phase 7: multi-asset bundle. Appended last so ALTER TYPE ADD VALUE keeps enum sort order.
  'GALLERY',
  'SYSTEM',
]);
export const groupRole = pgEnum('GroupRole', ['OWNER', 'ADMIN', 'MEMBER']);
export const messageThreadType = pgEnum('MessageThreadType', ['P2P', 'GROUP']);
export const messageLocalState = pgEnum('MessageLocalState', [
  'STUB',
  'FAILED',
  'READY',
]);
export const federationPayloadVerification = pgEnum(
  'FederationPayloadVerification',
  ['UNVERIFIED', 'VERIFIED', 'CONFLICT'],
);
export const pushPlatform = pgEnum('PushPlatform', ['ANDROID', 'WEB', 'IOS']);
export const uploadSessionStatus = pgEnum('UploadSessionStatus', [
  'UPLOADING',
  'COMPLETING',
  'COMPLETED',
  'ABORTED',
]);
export const peerStateEventType = pgEnum('PeerStateEventType', [
  'RELATIONSHIP_INTENT',
  'THREAD_CONTENT_HEAD',
]);
export const groupMetaMemberOperation = pgEnum('GroupMetaMemberOperation', [
  'MEMBER_UPSERT',
  'MEMBER_DEPART',
  'GROUP_PROFILE',
]);
export const relationshipIntentStatus = pgEnum('RelationshipIntentStatus', [
  'REQUESTED',
  'ACCEPTED',
  'REVOKED',
]);
export const requestProjectionStatus = pgEnum(
  'RequestProjectionStatus',
  RequestProjectionStatus,
);
export const durableTaskKind = pgEnum('DurableTaskKind', [
  'MUTATION',
  'PROJECTION',
]);
export const durableTaskScopeType = pgEnum('DurableTaskScopeType', [
  'THREAD',
  'USER_PAIR',
  'GROUP',
  'ACCOUNT_THREAD',
]);
export const durableTaskStatus = pgEnum('DurableTaskStatus', [
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'REJECTED',
  'FAILED',
  'SUPERSEDED',
]);

export const messageDeleteType = pgEnum('MessageDeleteType', [
  'USER_RETRACTION',
  'MODERATION_REMOVAL',
]);
export const fileSyncDirection = pgEnum('FileSyncDirection', [
  'OUTBOUND',
  'INBOUND',
]);
export const fileSyncStatus = pgEnum('FileSyncStatus', [
  'PENDING',
  'DOWNLOADING',
  'SUCCEEDED',
  'FAILED',
  'TOMBSTONED',
]);
export const fileSyncKind = pgEnum('FileSyncKind', [
  'FILE',
  'IMAGE',
  'VIDEO',
  'AUDIO',
  'LINK_CARD',
  'BUNDLE',
]);

/** Storage namespace for identity-bearing data. ID 0 is the single local namespace; positive IDs
 * are immutable verified federation identity epochs. */
export const identityNamespace = pgTable(
  'IdentityNamespace',
  {
    id: serial().primaryKey().notNull(),
    domain: varchar({ length: 63 }).notNull(),
    rootPublicKey: varchar({ length: 44 }),
    identityPinnedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    peerAssignedLocalNamespaceId: integer(),
    active: boolean().default(false).notNull(),
    trustLevel: varchar({ length: 31 }).default('unrecognized').notNull(),
    trustedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    lastSuccessAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    degradedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    degradationReason: varchar({ length: 255 }),
    degradationCount: integer().default(0).notNull(),
    haltedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    haltCode: integer(),
    haltReason: varchar({ length: 255 }),
    peerAcceptanceConfirmed: boolean().default(false).notNull(),
    localServiceAvailable: boolean().default(false).notNull(),
    remoteServiceReachable: boolean().default(false).notNull(),
    resetAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    dailyMsgLimit: integer(),
    dailyRequestLimit: integer(),
    dailyFileLimit: integer(),
    dailyFileBytesLimit: bigint({ mode: 'bigint' }),
    /** Unified outbound State Feed end for this federation identity epoch.
     * Namespace 0 is local and never allocates from this coordinate. */
    stateFeedEndId: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    /** Inbound State Feed drain progress for this peer. NULL means the feed
     * was never bootstrapped; the first fetch omits `after`. */
    stateFeedPulledThrough: bigint({ mode: 'bigint' }),
    /** Profile Namespace Feed coordinate. Row 0 is the local publisher allocator;
     * positive peer rows store the latest remote publisher head observed while
     * draining that peer. */
    profileNamespaceFeedEndId: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    /** Inbound Profile Namespace Feed drain progress for this peer. */
    profileNamespaceFeedPulledThrough: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    retiredAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('IdentityNamespace_one_active_per_domain_key')
      .on(table.domain)
      .where(sql`${table.id} > 0 AND ${table.active} = true`),
    uniqueIndex('IdentityNamespace_one_epoch_per_root_key')
      .on(table.rootPublicKey)
      .where(
        sql`${table.id} > 0 AND ${table.retiredAt} IS NULL AND ${table.rootPublicKey} IS NOT NULL`,
      ),
    index('IdentityNamespace_lastSuccessAt_idx').using(
      'btree',
      table.lastSuccessAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('IdentityNamespace_trustLevel_idx').using(
      'btree',
      table.trustLevel.asc().nullsLast().op('text_ops'),
    ),
    check(
      'IdentityNamespace_shape_check',
      sql`(
        ${table.id} = 0
        AND ${table.rootPublicKey} IS NULL
        AND ${table.identityPinnedAt} IS NULL
        AND ${table.peerAssignedLocalNamespaceId} IS NULL
        AND ${table.retiredAt} IS NULL
        AND ${table.active} = false
        AND ${table.trustLevel} = 'unrecognized'
        AND ${table.trustedAt} IS NULL
        AND ${table.lastSuccessAt} IS NULL
        AND ${table.degradedAt} IS NULL
        AND ${table.degradationReason} IS NULL
        AND ${table.degradationCount} = 0
        AND ${table.haltedAt} IS NULL
        AND ${table.haltCode} IS NULL
        AND ${table.haltReason} IS NULL
        AND ${table.peerAcceptanceConfirmed} = false
        AND ${table.localServiceAvailable} = false
        AND ${table.remoteServiceReachable} = false
        AND ${table.resetAt} IS NULL
      ) OR (
        ${table.id} > 0
        AND ${table.rootPublicKey} IS NOT NULL
        AND ${table.identityPinnedAt} IS NOT NULL
        AND (${table.peerAssignedLocalNamespaceId} IS NULL OR ${table.peerAssignedLocalNamespaceId} > 0)
      )`,
    ),
    check(
      'IdentityNamespace_trustLevel_check',
      sql`${table.trustLevel} IN ('unrecognized', 'establishing', 'pending', 'available', 'degraded', 'halted')`,
    ),
    check(
      'IdentityNamespace_active_check',
      sql`${table.active} = false OR (${table.id} > 0 AND ${table.retiredAt} IS NULL)`,
    ),
    check(
      'IdentityNamespace_retiredAt_check',
      sql`${table.retiredAt} IS NULL OR ${table.retiredAt} >= ${table.createdAt}`,
    ),
    check(
      'IdentityNamespace_stateFeedEndId_check',
      sql`${table.stateFeedEndId} >= 0 AND (${table.id} <> 0 OR ${table.stateFeedEndId} = 0)`,
    ),
    check(
      'IdentityNamespace_stateFeedPulledThrough_check',
      sql`${table.stateFeedPulledThrough} IS NULL OR ${table.stateFeedPulledThrough} >= 0`,
    ),
    check(
      'IdentityNamespace_profileNamespaceFeedEndId_check',
      sql`${table.profileNamespaceFeedEndId} >= 0`,
    ),
    check(
      'IdentityNamespace_profileNamespaceFeedPulledThrough_check',
      sql`${table.profileNamespaceFeedPulledThrough} >= 0`,
    ),
  ],
);

export const adminSession = pgTable(
  'AdminSession',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    adminId: integer().notNull(),
    tokenHash: text().notNull(),
    userAgent: varchar({ length: 255 }),
    ip: varchar({ length: 64 }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    lastAccessedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    expiresAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    revokedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    revokeReason: varchar({ length: 32 }),
  },
  (table) => [
    index('AdminSession_adminId_idx').using(
      'btree',
      table.adminId.asc().nullsLast().op('int4_ops'),
    ),
    index('AdminSession_expiresAt_idx').using(
      'btree',
      table.expiresAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    uniqueIndex('AdminSession_tokenHash_key').using(
      'btree',
      table.tokenHash.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.adminId],
      foreignColumns: [admin.id],
      name: 'AdminSession_adminId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

export const forwardMessage = pgTable(
  'ForwardMessage',
  {
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    messageId: bigint({ mode: 'bigint' }).primaryKey().notNull(),
    bundleId: varchar({ length: 26 }).notNull(),
  },
  (table) => [
    index('ForwardMessage_bundleId_idx').using(
      'btree',
      table.bundleId.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.bundleId],
      foreignColumns: [forwardBundle.id],
      name: 'ForwardMessage_bundleId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      columns: [table.messageId],
      foreignColumns: [message.id],
      name: 'ForwardMessage_messageId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const forwardBundle = pgTable(
  'ForwardBundle',
  {
    id: varchar({ length: 26 }).primaryKey().notNull(),
    messages: jsonb().notNull(),
    messageCount: integer().notNull(),
    assetCount: integer().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    totalBytes: bigint({ mode: 'bigint' }).notNull(),
    sourceDomain: varchar({ length: 63 }),
    publisherNamespaceId: integer(),
    sourceBundleId: varchar({ length: 64 }),
    createdBy: integer(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('ForwardBundle_createdBy_idx').using(
      'btree',
      table.createdBy.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('ForwardBundle_publisherNamespace_sourceBundleId_key').using(
      'btree',
      table.publisherNamespaceId.asc().nullsLast().op('int4_ops'),
      table.sourceBundleId.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'ForwardBundle_publisherNamespaceId_fkey',
    }).onDelete('restrict'),
    check('ForwardBundle_asset_count_check', sql`"assetCount" >= 0`),
    check(
      'ForwardBundle_messages_shape_check',
      sql`jsonb_typeof(messages) = 'array'::text`,
    ),
    check(
      'ForwardBundle_message_count_check',
      sql`("messageCount" >= 0) AND ("messageCount" <= 500)`,
    ),
    check('ForwardBundle_total_bytes_check', sql`"totalBytes" >= 0`),
  ],
);

/** Local user account. Foreign subjects are represented only by addressed references and profiles. */
export const account = pgTable(
  'Account',
  {
    id: serial().primaryKey().notNull(),
    account: varchar({ length: 31 }).notNull(),
    kind: varchar({ length: 16 }).default('USER').notNull(),
    namespaceId: integer().default(0).notNull(),
    defaultProfileRev: integer().default(0).notNull(),
    availability: varchar({ length: 16 }).default('AVAILABLE').notNull(),
    hashPwd: varchar({ length: 127 }),
    mustChangePassword: boolean().default(false).notNull(),
    disabledAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    clientStateFeedEndId: integer().default(0).notNull(),
    threadFeedEndId: integer().default(0).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    check('Account_namespace_check', sql`${table.namespaceId} = 0`),
    check(
      'Account_kind_check',
      sql`(${table.kind} = 'USER' AND ${table.account} <> '$system') OR (${table.kind} = 'SYSTEM' AND ${table.account} = '$system' AND ${table.hashPwd} IS NULL AND ${table.disabledAt} IS NOT NULL AND ${table.defaultProfileRev} = 0)`,
    ),
    check('Account_threadFeedEndId_check', sql`${table.threadFeedEndId} >= 0`),
    check(
      'Account_clientStateFeedEndId_check',
      sql`${table.clientStateFeedEndId} >= 0`,
    ),
    unique('Account_account_key').on(table.account),
    check('Account_account_check', sql`${table.account} NOT LIKE '!%'`),
    check(
      'Account_defaultProfileRev_check',
      sql`${table.defaultProfileRev} >= 0`,
    ),
    check(
      'Account_availability_check',
      sql`${table.availability} IN ('AVAILABLE', 'REMOVED')`,
    ),
  ],
);

/** Locally authored group account. Mirrored groups have a thread, never a GroupAccount. */
export const groupAccount = pgTable(
  'GroupAccount',
  {
    id: serial().primaryKey().notNull(),
    account: varchar({ length: 31 }).notNull(),
    defaultProfileRev: integer().default(0).notNull(),
    dissolvedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique('GroupAccount_account_key').on(table.account),
    check('GroupAccount_account_check', sql`${table.account} LIKE '!%'`),
    check(
      'GroupAccount_defaultProfileRev_check',
      sql`${table.defaultProfileRev} >= 0`,
    ),
  ],
);

/** Durable mutation and projection work. Ordering is isolated by kind and scopeKey;
 * task rows remain operational history while domain tables remain authoritative. */
export const durableTask = pgTable(
  'DurableTask',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    kind: durableTaskKind().notNull(),
    scopeType: durableTaskScopeType().notNull(),
    scopeKey: varchar({ length: 512 }).notNull(),
    taskType: varchar({ length: 64 }).notNull(),
    actorUserId: integer(),
    payload: jsonb().$type<Record<string, unknown>>().notNull(),
    checkpoint: jsonb()
      .$type<Record<string, unknown>>()
      .default(sql`'{}'::jsonb`)
      .notNull(),
    coalescingKey: varchar({ length: 512 }),
    status: durableTaskStatus().default('PENDING').notNull(),
    resultCode: integer(),
    lastError: varchar({ length: 1000 }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    startedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    completedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('DurableTask_pending_id_idx')
      .on(table.id)
      .where(sql`${table.status} = 'PENDING'`),
    index('DurableTask_blocking_scope_id_idx')
      .on(table.kind, table.scopeKey, table.id)
      .where(sql`${table.status} IN ('PENDING', 'PROCESSING')`),
    uniqueIndex('DurableTask_one_processing_per_scope')
      .on(table.kind, table.scopeKey)
      .where(sql`${table.status} = 'PROCESSING'`),
    index('DurableTask_pending_coalescing_key_idx')
      .on(table.coalescingKey, table.id)
      .where(
        sql`${table.status} = 'PENDING' AND ${table.coalescingKey} IS NOT NULL`,
      ),
    check('DurableTask_scope_key_check', sql`length(${table.scopeKey}) > 0`),
    check(
      'DurableTask_task_type_check',
      sql`${table.taskType} ~ '^[A-Z][A-Z0-9_]*$'`,
    ),
    check(
      'DurableTask_actor_user_id_check',
      sql`${table.actorUserId} IS NULL OR ${table.actorUserId} > 0`,
    ),
    check(
      'DurableTask_payload_check',
      sql`jsonb_typeof(${table.payload}) = 'object'`,
    ),
    check(
      'DurableTask_checkpoint_check',
      sql`jsonb_typeof(${table.checkpoint}) = 'object'`,
    ),
    check(
      'DurableTask_coalescing_key_check',
      sql`${table.coalescingKey} IS NULL OR length(${table.coalescingKey}) > 0`,
    ),
    check(
      'DurableTask_supersession_check',
      sql`${table.status} <> 'SUPERSEDED' OR ${table.coalescingKey} IS NOT NULL`,
    ),
    check(
      'DurableTask_status_timestamps_check',
      sql`(
        ${table.status} = 'PENDING'
        AND ${table.startedAt} IS NULL
        AND ${table.completedAt} IS NULL
      ) OR (
        ${table.status} = 'PROCESSING'
        AND ${table.startedAt} IS NOT NULL
        AND ${table.completedAt} IS NULL
      ) OR (
        ${table.status} IN ('SUCCEEDED', 'REJECTED', 'FAILED')
        AND ${table.startedAt} IS NOT NULL
        AND ${table.completedAt} IS NOT NULL
      ) OR (
        ${table.status} = 'SUPERSEDED'
        AND ${table.startedAt} IS NULL
        AND ${table.completedAt} IS NOT NULL
      )`,
    ),
    check(
      'DurableTask_timestamp_order_check',
      sql`(${table.startedAt} IS NULL OR ${table.startedAt} >= ${table.createdAt})
        AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})
        AND (${table.completedAt} IS NULL OR ${table.startedAt} IS NULL OR ${table.completedAt} >= ${table.startedAt})`,
    ),
    check(
      'DurableTask_result_check',
      sql`${table.resultCode} IS NULL OR ${table.status} IN ('SUCCEEDED', 'REJECTED')`,
    ),
    check(
      'DurableTask_error_check',
      sql`${table.lastError} IS NULL OR ${table.status} = 'FAILED'`,
    ),
  ],
);

export const userPreference = pgTable(
  'UserPreference',
  {
    userId: integer().notNull(),
    key: varchar({ length: 100 }).notNull(),
    value: jsonb().$type<unknown>().notNull(),
    revision: integer().default(0).notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.key] }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'UserPreference_userId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'UserPreference_value_not_json_null_check',
      sql`${table.value} <> 'null'::jsonb`,
    ),
    check('UserPreference_revision_check', sql`${table.revision} >= 0`),
  ],
);

export const accountThreadState = pgTable(
  'AccountThreadState',
  {
    id: serial().primaryKey().notNull(),
    /** Local account that owns this conversation state. */
    accountId: integer().notNull(),
    threadId: integer().notNull(),
    /** Local role fact. Null for P2P conversations. */
    role: groupRole(),
    lastReadSeq: integer().default(0).notNull(),
    /** Highest group-meta announcement coordinate actually displayed to this local account. */
    announcementReadFeedId: integer().default(0).notNull(),
    threadFeedId: integer().notNull().default(0),
    messageEndSeq: integer().notNull().default(0),
    tombstoneEndSeq: integer().notNull().default(0),
    unreadCount: integer().default(0).notNull(),
    /** Latest eligible local message sequences, descending; includes tomb slots. */
    previewSeqs: integer()
      .array()
      .notNull()
      .default(sql`'{}'::integer[]`),
    lastMentionSeq: integer(),
    /** Manager-side GroupRequestProjection watermarks for this group thread,
     * one fan-out end per direction: applications and invitations. Read stays
     * behind end until the manager consumes the pending request list. */
    joinRequestEndFeedId: integer().default(0).notNull(),
    groupInviteEndFeedId: integer().default(0).notNull(),
    /** Manager read watermark for join applications. -1 disables manager-only
     * attention for ordinary members; zero is a valid pre-first-request read position. */
    joinRequestReadFeedId: integer().default(-1).notNull(),
    /** Last group meta feed end id published to this member on the thread feed.
     * Null for P2P conversations; the thread fan-out keeps it at the canonical
     * GroupMeta coordinate. Client-visible: any writer must let the allocation
     * trigger see the change. */
    groupMetaFeedEndId: integer(),
    /** Profile revision of this conversation's counterpart (P2P peer or group)
     * last published to this member on the thread feed. Client-visible: any
     * writer must let the allocation trigger see the change. */
    threadProfileRev: integer().default(0).notNull(),
    /** Selected GROUP_PROFILE feed ID for a group, or selected peer message seq
     * for P2P. Null when the profile was initialized from an intent. */
    profileSourceId: integer(),
    muted: boolean().default(false).notNull(),
    /** Suppress this conversation's live delivery/catch-up for this participant. History stays stored. */
    blocked: boolean().default(false).notNull(),
    pinned: boolean().default(false).notNull(),
    pinnedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    /** Inclusive upper message sequence visible after this local participant leaves the relationship. */
    messageVisibleThroughSeq: bigint({ mode: 'number' }),
    /** Private label published through the thread feed; null restores the profile name. */
    alias: varchar({ length: 64 }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('AccountThreadState_accountId_threadId_key').on(
      table.accountId,
      table.threadId,
    ),
    index('AccountThreadState_threadId_idx').on(table.threadId),
    index('AccountThreadState_accountId_pinned_idx').on(
      table.accountId,
      table.pinned,
    ),
    uniqueIndex('AccountThreadState_accountId_threadFeedId_key').on(
      table.accountId,
      table.threadFeedId,
    ),
    check(
      'AccountThreadState_threadFeedId_check',
      sql`${table.threadFeedId} > 0`,
    ),
    check(
      'AccountThreadState_messageEndSeq_check',
      sql`${table.messageEndSeq} >= 0`,
    ),
    check(
      'AccountThreadState_tombstoneEndSeq_check',
      sql`${table.tombstoneEndSeq} >= 0`,
    ),
    check(
      'AccountThreadState_unreadCount_check',
      sql`${table.unreadCount} >= 0`,
    ),
    check(
      'AccountThreadState_lastReadSeq_check',
      sql`${table.lastReadSeq} >= 0`,
    ),
    check(
      'AccountThreadState_announcementReadFeedId_check',
      sql`${table.announcementReadFeedId} >= 0`,
    ),
    check(
      'AccountThreadState_threadProfileRev_check',
      sql`${table.threadProfileRev} >= 0`,
    ),
    check(
      'AccountThreadState_profileSourceId_check',
      sql`${table.profileSourceId} IS NULL OR ${table.profileSourceId} > 0`,
    ),
    check(
      'AccountThreadState_lastMentionSeq_check',
      sql`${table.lastMentionSeq} IS NULL OR ${table.lastMentionSeq} > 0`,
    ),
    check(
      'AccountThreadState_groupMetaFeedEndId_check',
      sql`${table.groupMetaFeedEndId} IS NULL OR ${table.groupMetaFeedEndId} >= 0`,
    ),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [account.id],
      name: 'AccountThreadState_accountId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'AccountThreadState_threadId_fkey',
    }).onDelete('restrict'),
    check(
      'AccountThreadState_messageVisibleThroughSeq_check',
      sql`${table.messageVisibleThroughSeq} IS NULL OR ${table.messageVisibleThroughSeq} >= 0`,
    ),
  ],
);

export const messageThread = pgTable(
  'MessageThread',
  {
    id: serial().primaryKey().notNull(),
    type: messageThreadType().notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    curSeq: integer().default(0).notNull(),
    /** Inclusive lower history boundary shared by every viewer of this thread. */
    clearedSeq: integer(),
    tombstoneEndSeq: integer().default(0).notNull(),
    /** Group subject address; null for a P2P thread. */
    groupAccount: varchar({ length: 31 }),
    groupDomain: varchar({ length: 63 }),
    /** Only authoritative local groups own a GroupAccount. */
    groupAccountId: integer(),
    /** Dissolution learned from the authority of a mirrored group. */
    groupDissolvedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    pullUntil: integer().default(0).notNull(),
    /** Identity namespace which owns this thread coordinate space. */
    authorityNamespaceId: integer().default(0).notNull(),
    /** Invalidates a response when the retained thread coordinate space itself is replaced. */
    federationVersion: integer().default(0).notNull(),
    /** Invalidates federation work captured before an effective authorization transition. */
    authorizationEpoch: integer().default(0).notNull(),
    /** Whether this thread can admit federation rounds and incoming content heads. */
    federationRoundsEnabled: boolean().default(false).notNull(),
  },
  (table) => [
    uniqueIndex('MessageThread_group_address_key').on(
      table.groupAccount,
      table.groupDomain,
      table.authorityNamespaceId,
    ),
    uniqueIndex('MessageThread_groupAccountId_key').on(table.groupAccountId),
    foreignKey({
      columns: [table.groupAccountId],
      foreignColumns: [groupAccount.id],
      name: 'MessageThread_groupAccountId_fkey',
    }).onDelete('restrict'),
    check(
      'MessageThread_group_type_check',
      sql`(${table.type} = 'GROUP' AND ${table.groupAccount} IS NOT NULL AND ${table.groupDomain} IS NOT NULL) OR (${table.type} = 'P2P' AND ${table.groupAccount} IS NULL AND ${table.groupDomain} IS NULL AND ${table.groupAccountId} IS NULL AND ${table.groupDissolvedAt} IS NULL)`,
    ),
    check(
      'MessageThread_group_identity_check',
      sql`${table.type} <> 'GROUP' OR ((${table.authorityNamespaceId} = 0) = (${table.groupAccountId} IS NOT NULL) AND ${table.groupAccount} LIKE '!%')`,
    ),
    foreignKey({
      columns: [table.authorityNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'MessageThread_authorityNamespaceId_fkey',
    }).onDelete('restrict'),
    check(
      'MessageThread_federationVersion_check',
      sql`${table.federationVersion} >= 0`,
    ),
    check(
      'MessageThread_authorizationEpoch_check',
      sql`${table.authorizationEpoch} >= 0`,
    ),
    check(
      'MessageThread_tombstoneEndSeq_check',
      sql`${table.tombstoneEndSeq} >= 0`,
    ),
    check(
      'MessageThread_clearedSeq_check',
      sql`${table.clearedSeq} IS NULL OR (${table.clearedSeq} >= 0 AND ${table.clearedSeq} <= ${table.curSeq})`,
    ),
  ],
);

/** Current thread access for a local user or a federated peer. */
export const threadAudience = pgTable(
  'ThreadAudience',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    targetNamespaceId: integer().default(0).notNull(),
    /** Non-null for a local user audience; null for a federated peer audience. */
    localUserId: integer(),
    threadId: integer().notNull(),
    /** Exclusive federation message-access lower bound. A peer audience may query only messages with
     *  a greater thread sequence. It advances when a closed relationship is reauthorized. */
    messageAccessAfterSeq: integer().default(0).notNull(),
    /** Exclusive Group Meta delta visibility floor in the group's canonical coordinate space. */
    groupMetaVisibleAfter: integer()
      .default(sql`0`)
      .notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('ThreadAudience_local_key')
      .on(table.localUserId, table.threadId)
      .where(sql`${table.localUserId} IS NOT NULL`),
    uniqueIndex('ThreadAudience_peer_key')
      .on(table.targetNamespaceId, table.threadId)
      .where(sql`${table.localUserId} IS NULL`),
    index('ThreadAudience_local_access_idx')
      .on(table.localUserId, table.threadId)
      .where(sql`${table.localUserId} IS NOT NULL`),
    index('ThreadAudience_peer_access_idx')
      .on(table.targetNamespaceId, table.threadId)
      .where(sql`${table.localUserId} IS NULL`),
    foreignKey({
      columns: [table.targetNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'ThreadAudience_targetNamespace_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.localUserId],
      foreignColumns: [account.id],
      name: 'ThreadAudience_localUserId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'ThreadAudience_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'ThreadAudience_target_check',
      sql`(${table.localUserId} IS NOT NULL AND ${table.targetNamespaceId} = 0) OR (${table.localUserId} IS NULL AND ${table.targetNamespaceId} > 0)`,
    ),
    check(
      'ThreadAudience_messageAccessAfterSeq_check',
      sql`${table.messageAccessAfterSeq} >= 0`,
    ),
    check(
      'ThreadAudience_groupMetaVisibleAfter_check',
      sql`${table.groupMetaVisibleAfter} >= 0`,
    ),
  ],
);

export const messageAsset = pgTable(
  'MessageAsset',
  {
    messageId: bigint({ mode: 'bigint' }).notNull(),
    threadId: integer().notNull(),
    digest: varchar({ length: 64 }).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.messageId, table.digest],
      name: 'MessageAsset_pkey',
    }),
    index('MessageAsset_digest_idx').using(
      'btree',
      table.digest.asc().nullsLast().op('text_ops'),
    ),
    index('MessageAsset_threadId_idx').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.messageId],
      foreignColumns: [message.id],
      name: 'MessageAsset_messageId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'MessageAsset_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

/**
 * Content-addressed media blob store. A row exists iff a verified blob sits in the formal CAS shard;
 * in-flight localization state lives in FileSyncProgress, not here. isDeleted marks a reaped blob whose
 * shard file has been (or is being) unlinked. See federation design doc §12.
 */
export const mediaAsset = pgTable(
  'MediaAsset',
  {
    digest: varchar({ length: 64 }).primaryKey().notNull(),
    bytes: bigint({ mode: 'bigint' }).notNull(),
    isDeleted: boolean().default(false).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('MediaAsset_isDeleted_idx').using(
      'btree',
      table.isDeleted.asc().nullsLast().op('bool_ops'),
    ),
  ],
);

export const message = pgTable(
  'Message',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    seq: integer().notNull(),
    /** Immutable author profile revision carried by the federated message. */
    profileRev: integer().default(0).notNull(),
    contentType: contentType().notNull(),
    content: jsonbText().notNull(),
    threadId: integer().notNull(),
    /** Author identity snapshot. Server notifications use the reserved $system identity. */
    creatorAccount: varchar({ length: 31 }),
    /** Publisher-scoped author profile namespace from the message envelope. */
    profileNamespaceId: integer().default(0).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    isDeleted: boolean().default(false).notNull(),
    clientMessageId: varchar({ length: 36 }),
    originSeq: integer(),
    originServerTime: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    /** Immutable namespace of the stream from which the message was accepted. Zero denotes local creation. */
    publisherNamespaceId: integer().default(0).notNull(),
    /** Local materialization state. STUB and FAILED are client-visible placeholders; only READY
     * participates in durable message-derived projections and federation publication. */
    localState: messageLocalState().default('READY').notNull(),
    /** Hop-independent digest of canonical wire content, sorted asset descriptors, and the optional
     * quoted-message payload digest. */
    payloadDigest: varchar({ length: 64 }),
    /** Monotonic result of comparing processing receipts with the retained payload digest. */
    federationPayloadVerification: federationPayloadVerification()
      .default('UNVERIFIED')
      .notNull(),
    /** Digest of the canonical immutable federation envelope received at the direct-origin
     * coordinate. NULL for local messages and rows accepted before envelope fingerprinting. */
    federationEnvelopeDigest: varchar({ length: 64 }),
  },
  (table) => [
    check('Message_seq_check', sql`${table.seq} > 0`),
    check('Message_profileRev_check', sql`${table.profileRev} >= 0`),
    check(
      'Message_system_creator_check',
      sql`${table.creatorAccount} IS NOT NULL AND ((${table.contentType} = 'SYSTEM' AND ${table.creatorAccount} = '$system' AND ${table.profileNamespaceId} = 0 AND ${table.profileRev} = 0 AND ${table.publisherNamespaceId} = 0) OR (${table.contentType} <> 'SYSTEM' AND ${table.creatorAccount} <> '$system'))`,
    ),
    check(
      'Message_payload_digest_check',
      sql`${table.contentType} = 'SYSTEM' OR ${table.payloadDigest} IS NOT NULL`,
    ),
    foreignKey({
      columns: [table.profileNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'Message_profileNamespaceId_fkey',
    }).onDelete('restrict'),
    uniqueIndex('Message_clientMessageId_key').using(
      'btree',
      table.clientMessageId.asc().nullsLast().op('text_ops'),
    ),
    index('Message_createdAt_idx').using(
      'btree',
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('Message_creator_address_idx').using(
      'btree',
      table.creatorAccount.asc().nullsLast().op('text_ops'),
      table.profileNamespaceId.asc().nullsLast().op('int4_ops'),
      table.publisherNamespaceId.asc().nullsLast().op('int4_ops'),
    ),
    index('Message_threadId_createdAt_idx').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('Message_threadId_id_idx').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.id.asc().nullsLast().op('int8_ops'),
    ),
    uniqueIndex('Message_threadId_source_originSeq_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.publisherNamespaceId.asc().nullsLast().op('int4_ops'),
      table.originSeq.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('Message_threadId_seq_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.seq.asc().nullsLast().op('int4_ops'),
    ),
    index('Message_threadId_ready_seq_idx')
      .on(table.threadId, table.seq)
      .where(sql`${table.localState} = 'READY'`),
    index('Message_threadId_seq_payloadDigest_idx')
      .on(table.threadId, table.seq, table.payloadDigest)
      .where(sql`${table.payloadDigest} IS NOT NULL`),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'Message_publisherNamespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'Message_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

/** Locally ordered deletion log consumed by apps. A row is created only after the target has a local
 * thread seq; federation tombstones which arrive before their message live in the separate table below. */
export const deletedMessage = pgTable(
  'DeletedMessage',
  {
    threadId: integer().notNull(),
    deletionSeq: integer().notNull(),
    messageSeq: integer().notNull(),
    type: messageDeleteType().notNull(),
    /** Namespace of the deletion stream from which this fact was accepted. Zero denotes local authority. */
    publisherNamespaceId: integer().default(0).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.deletionSeq],
      name: 'DeletedMessage_pkey',
    }),
    check('DeletedMessage_deletionSeq_check', sql`${table.deletionSeq} > 0`),
    check('DeletedMessage_messageSeq_check', sql`${table.messageSeq} > 0`),
    uniqueIndex('DeletedMessage_threadId_messageSeq_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.messageSeq.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'DeletedMessage_publisherNamespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'DeletedMessage_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

/** A deletion received before its federated message. It deliberately has no local seq: matching is by
 * the stable publisher coordinate (thread, publisherNamespaceId, messageSeq). */
export const federatedMessageTombstone = pgTable(
  'FederatedMessageTombstone',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    threadId: integer().notNull(),
    messageSeq: integer().notNull(),
    publisherNamespaceId: integer().notNull(),
    remoteDeletionSeq: integer().notNull(),
    type: messageDeleteType().notNull(),
    authorityDeletedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    check(
      'FederatedMessageTombstone_message_seq_check',
      sql`${table.messageSeq} > 0`,
    ),
    check(
      'FederatedMessageTombstone_remoteDeletionSeq_check',
      sql`${table.remoteDeletionSeq} > 0`,
    ),
    uniqueIndex('FederatedMessageTombstone_target_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.publisherNamespaceId.asc().nullsLast().op('int4_ops'),
      table.messageSeq.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('FederatedMessageTombstone_source_event_key').using(
      'btree',
      table.publisherNamespaceId.asc().nullsLast().op('int4_ops'),
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.remoteDeletionSeq.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'FederatedMessageTombstone_publisherNamespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'FederatedMessageTombstone_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

export const admin = pgTable(
  'Admin',
  {
    id: serial().primaryKey().notNull(),
    userId: integer().notNull(),
    enabled: boolean().default(true).notNull(),
    lastLoginIp: varchar({ length: 64 }),
    lastLoginAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    role: adminRole().default('SUPER_ADMIN').notNull(),
    twoFactorEnabled: boolean().default(false).notNull(),
    twoFactorSecretCipher: varchar({ length: 255 }),
    twoFactorEnabledAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    twoFactorLastUsedCounter: integer(),
    webauthnEnabled: boolean().default(false).notNull(),
  },
  (table) => [
    uniqueIndex('Admin_userId_key').using(
      'btree',
      table.userId.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'Admin_userId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

/** A message has one report regardless of who reported it. Soft-deleted reports
 * can be reactivated while the underlying message remains available. */
export const messageReport = pgTable(
  'MessageReport',
  {
    threadId: integer().notNull(),
    seq: integer().notNull(),
    isDeleted: boolean().default(false).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.seq],
      name: 'MessageReport_pkey',
    }),
    index('MessageReport_isDeleted_updatedAt_idx').on(
      table.isDeleted,
      table.updatedAt.desc(),
    ),
    foreignKey({
      columns: [table.threadId, table.seq],
      foreignColumns: [message.threadId, message.seq],
      name: 'MessageReport_threadId_seq_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const adminActionLog = pgTable(
  'AdminActionLog',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    adminId: integer().notNull(),
    adminRole: adminRole().notNull(),
    action: varchar({ length: 64 }).notNull(),
    targetType: varchar({ length: 32 }),
    targetId: varchar({ length: 64 }),
    ip: varchar({ length: 64 }),
    userAgent: varchar({ length: 255 }),
    route: varchar({ length: 255 }),
    status: adminAuditStatus().default('STARTED').notNull(),
    errorMessage: varchar({ length: 255 }),
    meta: jsonb(),
    at: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('AdminActionLog_action_idx').using(
      'btree',
      table.action.asc().nullsLast().op('text_ops'),
    ),
    index('AdminActionLog_adminId_idx').using(
      'btree',
      table.adminId.asc().nullsLast().op('int4_ops'),
    ),
    index('AdminActionLog_at_idx').using(
      'btree',
      table.at.asc().nullsLast().op('timestamptz_ops'),
    ),
    foreignKey({
      columns: [table.adminId],
      foreignColumns: [admin.id],
      name: 'AdminActionLog_adminId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const pendingMedia = pgTable(
  'PendingMedia',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    /** Present only for inbound federation downloads; points at the staged Message. */
    messageId: bigint({ mode: 'bigint' }),
    /** Outbound-only identity retained until the local Message is created. */
    threadId: integer(),
    creatorAccount: varchar({ length: 31 }),
    contentType: contentType(),
    content: text(),
    digest: varchar({ length: 64 }),
    clientMessageId: varchar({ length: 36 }),
    status: varchar({ length: 12 }).default('pending').notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    failReason: varchar({ length: 255 }),
    // Groups one message's files by batchId. INBOUND rows reference an existing STUB Message;
    // OUTBOUND rows retain the pre-Message staging fields above.
    direction: fileSyncDirection().default('OUTBOUND').notNull(),
    batchId: uuid().defaultRandom().notNull(),
    fileCnt: integer().default(1).notNull(),
    anyFailed: boolean().default(false).notNull(),
    originDomain: varchar({ length: 63 }),
    publisherNamespaceId: integer().default(0).notNull(),
    expectedAuthorizationEpoch: integer(),
    // A pulled text message may quote an earlier message whose media is still localizing. Keep the
    // wire coordinate durable until that target is promoted and has a receiver-local Message.seq.
    dependsOnOriginSeq: integer(),
  },
  (table) => [
    check(
      'PendingMedia_direction_shape_check',
      sql`(
          ${table.direction} = 'OUTBOUND'
          AND ${table.messageId} IS NULL
          AND ${table.threadId} IS NOT NULL
          AND ${table.creatorAccount} IS NOT NULL
          AND ${table.contentType} IS NOT NULL
          AND ${table.content} IS NOT NULL
          AND ${table.originDomain} IS NULL
          AND ${table.expectedAuthorizationEpoch} IS NULL
          AND ${table.dependsOnOriginSeq} IS NULL
        ) OR (
          ${table.direction} = 'INBOUND'
          AND ${table.messageId} IS NOT NULL
          AND ${table.threadId} IS NULL
          AND ${table.creatorAccount} IS NULL
          AND ${table.contentType} IS NULL
          AND ${table.content} IS NULL
          AND ${table.clientMessageId} IS NULL
          AND ${table.originDomain} IS NOT NULL
          AND ${table.expectedAuthorizationEpoch} IS NOT NULL
        )`,
    ),
    check(
      'PendingMedia_depends_on_origin_seq_check',
      sql`${table.dependsOnOriginSeq} IS NULL OR ${table.dependsOnOriginSeq} > 0`,
    ),
    check(
      'PendingMedia_expectedAuthorizationEpoch_check',
      sql`${table.expectedAuthorizationEpoch} IS NULL OR ${table.expectedAuthorizationEpoch} >= 0`,
    ),
    index('PendingMedia_batchId_idx').on(table.batchId),
    uniqueIndex('PendingMedia_messageId_key')
      .on(table.messageId)
      .where(sql`${table.messageId} IS NOT NULL`),
    uniqueIndex('PendingMedia_clientMessageId_key').using(
      'btree',
      table.clientMessageId.asc().nullsLast().op('text_ops'),
    ),
    index('PendingMedia_status_createdAt_idx').using(
      'btree',
      table.status.asc().nullsLast().op('text_ops'),
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('PendingMedia_threadId_idx').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
    ),
    index('PendingMedia_quote_dependency_idx').on(
      table.threadId,
      table.originDomain,
      table.dependsOnOriginSeq,
    ),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'PendingMedia_publisherNamespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.messageId],
      foreignColumns: [message.id],
      name: 'PendingMedia_messageId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'PendingMedia_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const uploadSession = pgTable(
  'UploadSession',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    uploadId: uuid().defaultRandom().notNull(),
    clientMessageId: varchar({ length: 36 }).notNull(),
    // Stable logical identity inside one staged message. It is deliberately independent of digest:
    // selecting the same bytes twice creates two parts but only one physical CAS object.
    partId: uuid().notNull(),
    position: integer().notNull(),
    partIntent: contentType().notNull(),
    creatorId: integer().notNull(),
    contentType: contentType().notNull(),
    originalName: varchar({ length: 100 }).notNull(),
    mimeType: varchar({ length: 255 }).notNull(),
    totalBytes: bigint({ mode: 'bigint' }).notNull(),
    receivedBytes: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    status: uploadSessionStatus().default('UPLOADING').notNull(),
    tmpKey: uuid().defaultRandom().notNull(),
    digest: varchar({ length: 64 }),
    result: jsonb(),
    errorReason: varchar({ length: 255 }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    completedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    abortedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('UploadSession_uploadId_key').on(table.uploadId),
    uniqueIndex('UploadSession_clientMessageId_partId_key').on(
      table.clientMessageId,
      table.partId,
    ),
    uniqueIndex('UploadSession_clientMessageId_position_key').on(
      table.clientMessageId,
      table.position,
    ),
    check(
      'UploadSession_position_check',
      sql`${table.position} BETWEEN 0 AND 9`,
    ),
    check(
      'UploadSession_partIntent_check',
      sql`${table.partIntent} <> 'GALLERY'`,
    ),
    index('UploadSession_creatorId_status_idx').on(
      table.creatorId,
      table.status,
    ),
    index('UploadSession_status_updatedAt_idx').on(
      table.status,
      table.updatedAt,
    ),
    index('UploadSession_digest_idx').on(table.digest),
    foreignKey({
      columns: [table.creatorId],
      foreignColumns: [account.id],
      name: 'UploadSession_creatorId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

/**
 * Per-file localization task shared by outbound upload and inbound download, keyed by (batchId, digest).
 * Holds the in-flight state (PENDING/DOWNLOADING/SUCCEEDED/FAILED) that previously lived on MediaAsset;
 * MediaAsset now stores only verified blobs. See federation design doc §12.
 */
export const fileSyncProgress = pgTable(
  'FileSyncProgress',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    batchId: uuid().notNull(),
    // Outbound logical identity. Nullable for inbound federation rows, whose source message payload
    // already owns item identity. A repeated digest may therefore occupy multiple outbound positions.
    partId: uuid(),
    position: integer(),
    digest: varchar({ length: 64 }).notNull(),
    direction: fileSyncDirection().notNull(),
    kind: fileSyncKind().notNull(),
    status: fileSyncStatus().default('PENDING').notNull(),
    bytesTotal: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    bytesReceived: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    originDomain: varchar({ length: 63 }),
    publisherNamespaceId: integer().default(0).notNull(),
    errorKind: varchar({ length: 255 }),
    // Tick-once guard: once this file's file-cnt/file-bytes quota has been charged, admin retry or crash-resume
    // must not re-charge it. Set true after the first successful claim.
    quotaCounted: boolean().default(false).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    // Outbound: per-file display payload used by barrier promotion. Inbound: the authorized S2S fetch
    // route persisted by global /missed so crash/quota recovery never depends on mutable relationships.
    payload: jsonb(),
  },
  (table) => [
    uniqueIndex('FileSyncProgress_batchId_partId_key')
      .on(table.batchId, table.partId)
      .where(sql`${table.partId} IS NOT NULL`),
    uniqueIndex('FileSyncProgress_batchId_position_key')
      .on(table.batchId, table.position)
      .where(sql`${table.position} IS NOT NULL`),
    index('FileSyncProgress_batchId_digest_idx').on(
      table.batchId,
      table.digest,
    ),
    index('FileSyncProgress_digest_idx').on(table.digest),
    index('FileSyncProgress_status_updatedAt_idx').on(
      table.status,
      table.updatedAt,
    ),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'FileSyncProgress_publisherNamespaceId_fkey',
    }).onDelete('restrict'),
    check(
      'FileSyncProgress_position_check',
      sql`${table.position} IS NULL OR ${table.position} BETWEEN 0 AND 9`,
    ),
    check(
      'FileSyncProgress_outbound_part_check',
      sql`${table.direction} <> 'OUTBOUND' OR (${table.partId} IS NOT NULL AND ${table.position} IS NOT NULL)`,
    ),
  ],
);

/** Immutable user and group profile snapshots addressed independently of account records. */
export const profileTable = pgTable(
  'Profile',
  {
    account: varchar({ length: 31 }).notNull(),
    /** Local publisher namespace that disclosed or owns this immutable snapshot. */
    publisherNamespaceId: integer().notNull(),
    /** Publisher-scoped profile subject namespace. */
    profileNamespaceId: integer().notNull(),
    profileRev: integer().notNull(),
    displayName: varchar({ length: 31 }).notNull(),
    avatar: text().default('').notNull(),
    bio: varchar({ length: 255 }).default('').notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.publisherNamespaceId,
        table.account,
        table.profileNamespaceId,
        table.profileRev,
      ],
      name: 'Profile_pkey',
    }),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'Profile_publisherNamespaceId_fkey',
    }).onDelete('restrict'),
    check('Profile_profileRev_check', sql`${table.profileRev} > 0`),
  ],
);

/** Per-client compacted state projection. This is the device-facing analogue of PeerStateFeed:
 * feedId is the owning user's unified client-state scan coordinate.
 * Intent tombstones remain as
 * REVOKED snapshots, so a client resuming from an older cursor can converge without a delete log. */
export const clientStateFeed = pgTable(
  'ClientStateFeed',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: integer().notNull(),
    /** Event-specific stable identity used only for compaction within one local account. */
    compactionKey: text().notNull(),
    account: varchar({ length: 31 }).notNull(),
    domain: varchar({ length: 63 }).notNull(),
    eventType: varchar({ length: 31 }).notNull(),
    subjectAccount: varchar({ length: 31 }).default('').notNull(),
    subjectNamespaceId: integer().default(0).notNull(),
    namespaceId: integer().default(0).notNull(),
    feedId: integer().notNull(),
    body: jsonb().notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique('ClientStateFeed_compaction_key').on(
      table.userId,
      table.compactionKey,
    ),
    index('ClientStateFeed_user_feedId_idx').on(table.userId, table.feedId),
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'ClientStateFeed_namespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'ClientStateFeed_userId_fkey',
    }).onDelete('cascade'),
    check('ClientStateFeed_feedId_check', sql`${table.feedId} > 0`),
  ],
);

/** Shared authoritative request projection for USER→GROUP applications and GROUP→USER invitations. */
export const groupRequestProjection = pgTable(
  'GroupRequestProjection',
  {
    threadId: integer().notNull(),
    memberAccount: varchar({ length: 31 }).notNull(),
    profileNamespaceId: integer().notNull(),
    memberProfileRev: integer().notNull(),
    direction: varchar({ length: 15 }).notNull(),
    feedId: integer().notNull(),
    status: requestProjectionStatus()
      .$type<RequestProjectionStatusValue>()
      .notNull(),
    note: varchar({ length: 255 }).default('').notNull(),
    requestedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    expiresAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.threadId,
        table.memberAccount,
        table.profileNamespaceId,
        table.direction,
      ],
      name: 'GroupRequestProjection_pkey',
    }),
    uniqueIndex('GroupRequestProjection_direction_feed_key').on(
      table.threadId,
      table.direction,
      table.feedId,
    ),
    index('GroupRequestProjection_thread_feed_idx').on(
      table.threadId,
      table.feedId,
    ),
    index('GroupRequestProjection_expiry_idx').on(table.expiresAt),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'GroupRequestProjection_threadId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.profileNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'GroupRequestProjection_profileNamespaceId_fkey',
    }).onDelete('cascade'),
    check('GroupRequestProjection_feedId_check', sql`${table.feedId} > 0`),
    check(
      'GroupRequestProjection_direction_check',
      sql`${table.direction} IN ('APPLICATION', 'INVITATION')`,
    ),
    check(
      'GroupRequestProjection_retention_check',
      sql`${table.expiresAt} > ${table.requestedAt} AND ${table.expiresAt} <= ${table.requestedAt} + INTERVAL '7 days'`,
    ),
  ],
);

export const systemSetting = pgTable('SystemSetting', {
  key: varchar({ length: 63 }).primaryKey().notNull(),
  value: text().notNull(),
  updatedAt: timestamp({
    precision: 3,
    withTimezone: true,
    mode: 'date',
  }).notNull(),
});

/** This installation's immutable federation identity plus its root key material. Private keys are
 * stored here unencrypted: database access control is the secret boundary. */
/** Local root-identity epochs. Every epoch ever generated is retained forever —
 *  private key material included — because sealed challenges under retired roots
 *  must stay openable (Transport and Security 1.5). Exactly one row per domain is
 *  claimable: the root that authorizes new signing certificates and claims
 *  S2S-Root-Key right now. A rotated-out predecessor keeps its row and stays in
 *  the published roots group until unpublishedAt is set by an operator, after
 *  every recognized peer adopted the rotation or the rotation was abandoned;
 *  rotation itself never cleans up. */
export const localFederationRoot = pgTable(
  'LocalFederationRoot',
  {
    id: serial().primaryKey().notNull(),
    domain: varchar({ length: 63 }).notNull(),
    rootPublicKey: varchar({ length: 44 }).notNull().unique(),
    rootPrivateKey: varchar({ length: 44 }).notNull(),
    notBefore: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    notAfter: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    claimable: boolean().default(false).notNull(),
    unpublishedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('LocalFederationRoot_one_claimable_key')
      .on(table.domain)
      .where(sql`${table.claimable} = true`),
    check(
      'LocalFederationRoot_validity_check',
      sql`${table.notBefore} < ${table.notAfter}`,
    ),
    check(
      'LocalFederationRoot_claimable_check',
      sql`${table.claimable} = false OR ${table.unpublishedAt} IS NULL`,
    ),
  ],
);

/** Local signing-key certificates under their authorizing root epoch. Exactly one key is
 *  selected for new outbound signatures at any instant (LocalFederationSigningState.currentKeyId).
 *  keyId is globally unique and permanently bound to one public key; rows are retained forever
 *  with their private material so sealed challenges under any historical key stay openable. */
export const localFederationSigningKey = pgTable(
  'LocalFederationSigningKey',
  {
    rootId: integer()
      .notNull()
      .references(() => localFederationRoot.id, { onDelete: 'restrict' }),
    keyId: varchar({ length: 127 }).primaryKey().notNull(),
    publicKey: varchar({ length: 44 }).notNull(),
    privateKey: varchar({ length: 44 }).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    notBefore: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    notAfter: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
  },
  (table) => [
    check(
      'LocalFederationSigningKey_validity_check',
      sql`${table.notBefore} < ${table.notAfter}`,
    ),
  ],
);

/** Single-row-per-domain local signing selection state. plannedSwitchAt/plannedSuccessorKeyId are
 * both null or both set; the planned switch is applied atomically by the key-lifecycle maintainer. */
export const localFederationSigningState = pgTable(
  'LocalFederationSigningState',
  {
    domain: varchar({ length: 63 }).primaryKey().notNull(),
    currentKeyId: varchar({ length: 127 }).notNull(),
    plannedSwitchAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    plannedSuccessorKeyId: varchar({ length: 127 }),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.currentKeyId],
      foreignColumns: [localFederationSigningKey.keyId],
      name: 'LocalFederationSigningState_current_key_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.plannedSuccessorKeyId],
      foreignColumns: [localFederationSigningKey.keyId],
      name: 'LocalFederationSigningState_successor_key_fkey',
    }).onDelete('set null'),
    check(
      'LocalFederationSigningState_plan_check',
      sql`(${table.plannedSwitchAt} IS NULL) = (${table.plannedSuccessorKeyId} IS NULL)`,
    ),
  ],
);

/** Administrator review queue for identity-epoch changes recognized through a
 * verified arrival: a domain re-binding or a root rotation. One pending review
 * per matched namespace; claim keeps the fetched root-group snapshot and
 * arrival facts for the reviewer. Resolved rows are retained as audit
 * history. */
export const federationIdentityReview = pgTable(
  'FederationIdentityReview',
  {
    id: serial().primaryKey().notNull(),
    /** 'domain-rebind' | 'root-rotation' */
    kind: varchar({ length: 15 }).notNull(),
    matchedNamespaceId: integer()
      .notNull()
      .references(() => identityNamespace.id, { onDelete: 'cascade' }),
    /** Arrival domain: the domain the peer now operates from. */
    nextDomain: varchar({ length: 63 }).notNull(),
    /** Root the arrival claims (rotation) or the already-pinned root
     *  (re-binding). */
    claimedRoot: varchar({ length: 44 }).notNull(),
    /** Reviewer-facing snapshot: fetched root group, previous pin, sender
     *  disclosure, and arrival timestamps. */
    claim: jsonb().$type<Record<string, unknown>>().notNull(),
    /** 'pending' | 'approved' | 'rejected' */
    status: varchar({ length: 15 }).default('pending').notNull(),
    reviewedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    verifiedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('FederationIdentityReview_one_pending_per_namespace_key')
      .on(table.matchedNamespaceId)
      .where(sql`${table.status} = 'pending'`),
    check(
      'FederationIdentityReview_matchedNamespace_check',
      sql`${table.matchedNamespaceId} > 0`,
    ),
    check(
      'FederationIdentityReview_kind_check',
      sql`${table.kind} IN ('domain-rebind', 'root-rotation')`,
    ),
    check(
      'FederationIdentityReview_status_check',
      sql`${table.status} IN ('pending', 'approved', 'rejected')`,
    ),
    check(
      'FederationIdentityReview_reviewed_check',
      sql`(${table.status} = 'pending') = (${table.reviewedAt} IS NULL)`,
    ),
  ],
);

/** Per-peer compacted state feed. A changed key receives a new feed ID; gaps are expected and
 * consumers advance using scannedThrough, never the last item. */
export const peerStateFeed = pgTable(
  'PeerStateFeed',
  {
    namespaceId: integer().notNull(),
    account: varchar({ length: 31 }).notNull(),
    eventType: peerStateEventType().notNull(),
    subjectAccount: varchar({ length: 31 }).default('').notNull(),
    subjectNamespaceId: integer().default(0).notNull(),
    feedId: bigint({ mode: 'bigint' }).notNull(),
    body: jsonb().notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.namespaceId,
        table.account,
        table.eventType,
        table.subjectAccount,
        table.subjectNamespaceId,
      ],
      name: 'PeerStateFeed_pkey',
    }),
    uniqueIndex('PeerStateFeed_namespace_feedId_key').on(
      table.namespaceId,
      table.feedId,
    ),
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'PeerStateFeed_namespace_fkey',
    }).onDelete('restrict'),
    check('PeerStateFeed_feedId_check', sql`${table.feedId} > 0`),
    check(
      'PeerStateFeed_subject_check',
      sql`(${table.eventType} = 'RELATIONSHIP_INTENT' AND ${table.subjectAccount} <> '' AND ${table.subjectNamespaceId} > 0)
        OR (${table.eventType} = 'THREAD_CONTENT_HEAD' AND ((${table.account} LIKE '!%' AND ${table.subjectAccount} = '' AND ${table.subjectNamespaceId} = 0) OR (${table.account} NOT LIKE '!%' AND ${table.subjectAccount} <> '' AND ${table.subjectNamespaceId} = ${table.namespaceId})))`,
    ),
  ],
);

/** One group-scoped Group Meta coordinate space. Local groups author it; remote groups mirror it. */
export const groupMeta = pgTable(
  'GroupMeta',
  {
    threadId: integer().primaryKey().notNull(),
    /** Origin allocation end or mirror's last completely applied round cursor. */
    metaEndId: integer().default(0).notNull(),
    /** Profile revision carried by the GROUP_PROFILE item at the end coordinate.
     * Zero while the group has no profile revision yet. */
    profileRev: integer().default(0).notNull(),
    /** Null feed id means the current announcement is unknown, not an explicit clear.
     * A positive feed id with null text means the announcement was cleared. */
    announcementFeedId: integer(),
    announcementText: text(),
    /** Greatest meta feed end merged from committed State Feed items. */
    metaTargetId: integer().default(0).notNull(),
    /** Greatest source meta feed id durably scanned by meta rounds. */
    metaProcessedThroughId: integer().default(0).notNull(),
    /** Fixed through of the currently open full-snapshot recovery drain. NULL
     * selects delta rounds; only writers that also zero the processed cursor
     * reopen the drain, and the drain's final transaction closes it. */
    metaRecoveryThroughId: integer(),
    /** Group-scoped request number streams. Applications and invitations
     * advance independently, so every manager copies the same event number and
     * GC deletions can never reuse one. */
    applicationEndId: integer().default(0).notNull(),
    invitationEndId: integer().default(0).notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'GroupMeta_threadId_fkey',
    }).onDelete('cascade'),
    check('GroupMeta_metaEndId_check', sql`${table.metaEndId} >= 0`),
    check('GroupMeta_profileRev_check', sql`${table.profileRev} >= 0`),
    check(
      'GroupMeta_announcementFeedId_check',
      sql`${table.announcementFeedId} IS NULL OR ${table.announcementFeedId} > 0`,
    ),
    check(
      'GroupMeta_announcementText_check',
      sql`${table.announcementText} IS NULL OR (${table.announcementFeedId} IS NOT NULL AND char_length(${table.announcementText}) BETWEEN 1 AND 4096)`,
    ),
    check('GroupMeta_metaTargetId_check', sql`${table.metaTargetId} >= 0`),
    check(
      'GroupMeta_metaProcessedThroughId_check',
      sql`${table.metaProcessedThroughId} >= 0
        AND ${table.metaProcessedThroughId} <= ${table.metaTargetId}`,
    ),
    check(
      'GroupMeta_metaRecovery_check',
      sql`${table.metaRecoveryThroughId} IS NULL OR (
        ${table.metaProcessedThroughId} < ${table.metaRecoveryThroughId}
        AND ${table.metaRecoveryThroughId} <= ${table.metaTargetId})`,
    ),
    check(
      'GroupMeta_applicationEndId_check',
      sql`${table.applicationEndId} >= 0`,
    ),
    check(
      'GroupMeta_invitationEndId_check',
      sql`${table.invitationEndId} >= 0`,
    ),
  ],
);

/** One current Group Meta operation per stable key on origins and mirrors. */
export const groupMetaMemberFeed = pgTable(
  'GroupMetaMemberFeed',
  {
    threadId: integer().notNull(),
    feedId: integer().notNull(),
    memberAccount: varchar({ length: 31 }).notNull(),
    profileNamespaceId: integer().notNull(),
    operation: groupMetaMemberOperation().notNull(),
    body: jsonb().$type<Record<string, unknown>>().notNull(),
    /** Backend-only member-message coordinate behind the currently published
     * profile revision. Null for an intent-initialized membership. */
    profileSourceSeq: integer(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.feedId],
      name: 'GroupMetaMemberFeed_pkey',
    }),
    uniqueIndex('GroupMetaMemberFeed_member_key').on(
      table.threadId,
      table.memberAccount,
      table.profileNamespaceId,
    ),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'GroupMetaMemberFeed_threadId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.profileNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'GroupMetaMemberFeed_profileNamespaceId_fkey',
    }).onDelete('restrict'),
    check('GroupMetaMemberFeed_feedId_check', sql`${table.feedId} > 0`),
    check(
      'GroupMetaMemberFeed_profileSourceSeq_check',
      sql`${table.profileSourceSeq} IS NULL OR ${table.profileSourceSeq} > 0`,
    ),
    check(
      'GroupMetaMemberFeed_body_check',
      sql`jsonb_typeof(${table.body}) = 'object'
        AND ((${table.operation} = 'MEMBER_UPSERT' AND ${table.body} <> '{}'::jsonb)
          OR (${table.operation} = 'MEMBER_DEPART' AND ${table.body} <> '{}'::jsonb)
          OR (${table.operation} = 'GROUP_PROFILE'
            AND ${table.body} <> '{}'::jsonb))`,
    ),
  ],
);

/** One shared Profile Namespace Feed serving table. Every peer pulls the same
 * compacted items: the body is the affected identity's namespace id, so the
 * primary key carries it and no body column exists. */
export const profileNamespaceFeed = pgTable(
  'ProfileNamespaceFeed',
  {
    namespaceId: integer().primaryKey().notNull(),
    feedId: bigint({ mode: 'bigint' }).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('ProfileNamespaceFeed_feedId_key').on(table.feedId),
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'ProfileNamespaceFeed_namespace_fkey',
    }).onDelete('restrict'),
    check('ProfileNamespaceFeed_feedId_check', sql`${table.feedId} > 0`),
  ],
);

/** Local cache of publisher-scoped namespace bindings for display and
 * vouching. A row describes the identity referenced by profileNamespaceId
 * inside the publisherNamespaceId space; expired marks the tomb until
 * re-resolution commits fresh bindings. */
export const profileNamespaceChangeFeed = pgTable(
  'ProfileNamespaceChangeFeed',
  {
    publisherNamespaceId: integer().notNull(),
    profileNamespaceId: integer().notNull(),
    changeId: bigint({ mode: 'bigint' }).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.publisherNamespaceId, table.profileNamespaceId],
      name: 'ProfileNamespaceChangeFeed_pkey',
    }),
    uniqueIndex('ProfileNamespaceChangeFeed_changeId_key').on(table.changeId),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'ProfileNamespaceChangeFeed_publisher_fkey',
    }).onDelete('restrict'),
    check(
      'ProfileNamespaceChangeFeed_changeId_check',
      sql`${table.changeId} > 0`,
    ),
  ],
);

export const profileNamespaceChangeFeedHead = pgTable(
  'ProfileNamespaceChangeFeedHead',
  {
    id: integer().primaryKey().notNull(),
    endId: bigint({ mode: 'bigint' }).notNull().default(0n),
  },
  (table) => [
    check('ProfileNamespaceChangeFeedHead_id_check', sql`${table.id} = 0`),
    check(
      'ProfileNamespaceChangeFeedHead_endId_check',
      sql`${table.endId} >= 0`,
    ),
  ],
);

export const profileNamespace = pgTable(
  'ProfileNamespace',
  {
    publisherNamespaceId: integer().notNull(),
    profileNamespaceId: integer().notNull(),
    domain: varchar({ length: 63 }),
    rootPublicKey: varchar({ length: 44 }),
    updateFeedId: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
    expired: boolean().default(true).notNull(),
    /** Lifecycle status of the bound namespace: ACTIVE (in use) or ARCHIVED
     *  (reset-retired, last bindings retained for historical rendering).
     *  Orthogonal to `expired` (transient freshness while a refresh
     *  converges). UNRECOVERABLE (permanent loss) is not stored here — it
     *  is a federation error code that writes a row in
     *  ProfileNamespaceTombstone instead. */
    status: varchar({ length: 16 }).default('ACTIVE').notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.publisherNamespaceId, table.profileNamespaceId],
      name: 'ProfileNamespace_pkey',
    }),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'ProfileNamespace_publisher_fkey',
    }).onDelete('restrict'),
    check(
      'ProfileNamespace_updateFeedId_check',
      sql`${table.updateFeedId} >= 0`,
    ),
    check(
      'ProfileNamespace_bindings_check',
      sql`(${table.domain} IS NULL AND ${table.rootPublicKey} IS NULL) OR (${table.domain} IS NOT NULL AND ${table.rootPublicKey} IS NOT NULL)`,
    ),
    check(
      'ProfileNamespace_status_check',
      sql`${table.status} IN ('ACTIVE', 'ARCHIVED')`,
    ),
  ],
);

/** Federation-reported permanent loss of a namespace binding (the
 *  `FEDERATION_NAMESPACE_UNRECOVERABLE` s2s error code). A row here is a
 *  tomb: the coordinate pair is retained for rendering "gone" while the
 *  binding content is empty. Distinct from ProfileNamespace.expired
 *  (transient) and .status ARCHIVED (retired-but-retained). */
export const profileNamespaceTombstone = pgTable(
  'ProfileNamespaceTombstone',
  {
    publisherNamespaceId: integer().notNull(),
    profileNamespaceId: integer().notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.publisherNamespaceId, table.profileNamespaceId],
      name: 'ProfileNamespaceTombstone_pkey',
    }),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'ProfileNamespaceTombstone_publisher_fkey',
    }).onDelete('restrict'),
  ],
);

/** Federation-reported permanent loss of a profile (the
 *  `FEDERATION_PROFILE_UNRECOVERABLE` s2s error code). Tomb spans every rev
 *  of the account in that namespace, so the key omits profileRev. Sparse by
 *  design: only unrecoverable accounts have a row. */
export const profileTombstone = pgTable(
  'ProfileTombstone',
  {
    publisherNamespaceId: integer().notNull(),
    profileNamespaceId: integer().notNull(),
    account: varchar({ length: 31 }).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.publisherNamespaceId,
        table.profileNamespaceId,
        table.account,
      ],
      name: 'ProfileTombstone_pkey',
    }),
    foreignKey({
      columns: [table.publisherNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'ProfileTombstone_publisher_fkey',
    }).onDelete('restrict'),
  ],
);

/** One authoritative directed request as an independent fact: the initiator
 * account requests the receiver account, both fully namespaced. Rows are not
 * foreign-keyed to RelationshipPair — the pair is the relationship fact and
 * is matched by endpoint coordinates. The '!' account prefix separates USER
 * and GROUP endpoints, so no explicit endpoint type is stored. */
export const relationshipIntent = pgTable(
  'RelationshipIntent',
  {
    authorAccount: varchar({ length: 31 }).notNull(),
    /** The initiator endpoint's own identity namespace; 0 for local authors. */
    authorNamespaceId: integer().notNull(),
    receiverAccount: varchar({ length: 31 }).notNull(),
    /** The receiver endpoint's own identity namespace; 0 for local receivers. */
    receiverNamespaceId: integer().notNull(),
    status: relationshipIntentStatus().notNull(),
    /** Immutable author profile reference retained for the current request flow. */
    profileNamespaceId: integer().notNull(),
    profileRev: integer().notNull(),
    messageEndSeq: integer().notNull(),
    tombstoneEndSeq: integer().notNull(),
    note: varchar({ length: 255 }).default('').notNull(),
    requestedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    expiresAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.authorAccount,
        table.authorNamespaceId,
        table.receiverAccount,
        table.receiverNamespaceId,
      ],
      name: 'RelationshipIntent_pkey',
    }),
    foreignKey({
      columns: [table.authorNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'RelationshipIntent_authorNamespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.receiverNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'RelationshipIntent_receiverNamespaceId_fkey',
    }).onDelete('restrict'),
    check(
      'RelationshipIntent_author_namespace_check',
      sql`${table.authorNamespaceId} >= 0`,
    ),
    check(
      'RelationshipIntent_receiver_namespace_check',
      sql`${table.receiverNamespaceId} >= 0`,
    ),
    check(
      'RelationshipIntent_head_check',
      sql`${table.messageEndSeq} >= 0 AND ${table.tombstoneEndSeq} >= 0`,
    ),
    check(
      'RelationshipIntent_profileNamespaceId_check',
      sql`${table.profileNamespaceId} >= 0`,
    ),
    check('RelationshipIntent_profileRev_check', sql`${table.profileRev} >= 0`),
    check(
      'RelationshipIntent_expiry_check',
      sql`(${table.status} = 'REQUESTED' AND ${table.requestedAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.expiresAt} > ${table.requestedAt} AND ${table.expiresAt} <= ${table.requestedAt} + INTERVAL '7 days') OR (${table.status} = 'ACCEPTED' AND ${table.requestedAt} IS NOT NULL AND ${table.expiresAt} IS NULL) OR (${table.status} = 'REVOKED' AND ${table.expiresAt} IS NULL)`,
    ),
  ],
);

/** Canonical unordered pair row. Every relationship transaction locks this row before touching either
 * directed request, preventing crossed inserts from both missing one another. */
export const relationshipPair = pgTable(
  'RelationshipPair',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    kind: varchar({ length: 16 }).notNull(),
    endpointAType: varchar({ length: 8 }).notNull(),
    endpointAAccount: varchar({ length: 31 }).notNull(),
    endpointBType: varchar({ length: 8 }).notNull(),
    endpointBAccount: varchar({ length: 31 }).notNull(),
    /** Side A is always the local endpoint, so its namespace is pinned 0.
     * Side B carries the remote peer's own namespace; 0 when both endpoints
     * are local. Storing both sides symmetrically keeps coordinate joins free
     * of which-side-is-local literals. */
    endpointANamespaceId: integer().default(0).notNull(),
    endpointBNamespaceId: integer().default(0).notNull(),
    threadId: integer(),
    active: boolean().default(false).notNull(),
    established: boolean().default(false).notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique('RelationshipPair_endpoints_key').on(
      table.endpointAType,
      table.endpointAAccount,
      table.endpointBType,
      table.endpointBAccount,
      table.endpointBNamespaceId,
    ),
    index('RelationshipPair_endpointA_idx').on(
      table.endpointAType,
      table.endpointAAccount,
      table.active,
    ),
    index('RelationshipPair_endpointB_idx').on(
      table.endpointBType,
      table.endpointBAccount,
      table.active,
    ),
    uniqueIndex('RelationshipPair_p2p_threadId_key')
      .on(table.threadId)
      .where(sql`${table.kind} = 'P2P' AND ${table.threadId} IS NOT NULL`),
    index('RelationshipPair_thread_kind_active_idx').on(
      table.threadId,
      table.kind,
      table.active,
    ),
    foreignKey({
      columns: [table.endpointANamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'RelationshipPair_endpointANamespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.endpointBNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'RelationshipPair_endpointBNamespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'RelationshipPair_threadId_fkey',
    }).onDelete('set null'),
    check(
      'RelationshipPair_kind_check',
      sql`${table.kind} IN ('P2P', 'GROUP_MEMBER')`,
    ),
    check(
      'RelationshipPair_endpoint_type_check',
      sql`${table.endpointAType} IN ('USER', 'GROUP') AND ${table.endpointBType} IN ('USER', 'GROUP') AND ((${table.kind} = 'P2P' AND ${table.endpointAType} = 'USER' AND ${table.endpointBType} = 'USER') OR (${table.kind} = 'GROUP_MEMBER' AND ${table.endpointAType} <> ${table.endpointBType}))`,
    ),
    check(
      'RelationshipPair_local_side_check',
      sql`${table.endpointANamespaceId} = 0`,
    ),
    check(
      'RelationshipPair_endpoint_namespace_check',
      sql`${table.endpointBNamespaceId} >= 0`,
    ),
    check(
      'RelationshipPair_distinct_endpoints_check',
      sql`(${table.endpointAType}, ${table.endpointAAccount}) <> (${table.endpointBType}, ${table.endpointBAccount})`,
    ),
  ],
);

/** A durable inclusive publisher-sequence interval not yet committed by reverse synchronization. */
export const federationThreadHistoryGap = pgTable(
  'FederationThreadHistoryGap',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    threadId: integer().notNull(),
    namespaceId: integer().notNull(),
    /** First missing publisher message coordinate, inclusive. */
    startSeq: integer().notNull(),
    /** Last missing publisher message coordinate, inclusive. */
    endSeq: integer().notNull(),
    /** Fixed translation from publisher coordinates to local Message.seq values. */
    messageSeqOffset: integer().default(0).notNull(),
    /** False when the publisher has declared this interval unavailable. */
    recoverable: boolean().default(true).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique('FederationThreadHistoryGap_threadId_id_key').on(
      table.threadId,
      table.namespaceId,
      table.id,
    ),
    uniqueIndex('FederationThreadHistoryGap_interval_key').on(
      table.threadId,
      table.namespaceId,
      table.startSeq,
      table.endSeq,
    ),
    index('FederationThreadHistoryGap_recoverable_idx')
      .on(table.threadId, table.namespaceId, table.endSeq)
      .where(sql`${table.recoverable} = true`),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'FederationThreadHistoryGap_threadId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'FederationThreadHistoryGap_namespaceId_fkey',
    }).onDelete('restrict'),
    check(
      'FederationThreadHistoryGap_interval_check',
      sql`${table.startSeq} > 0
        AND ${table.endSeq} >= ${table.startSeq}
        AND ${table.messageSeqOffset} >= 0`,
    ),
  ],
);

/** Durable synchronization facts for one publisher's coordinate space within a local thread. */
export const federationThreadSyncState = pgTable(
  'FederationThreadSyncState',
  {
    threadId: integer().notNull(),
    namespaceId: integer().notNull(),
    /** Greatest message-query target merged from committed State Feed items. */
    messageTargetSeq: integer().default(0).notNull(),
    /** Greatest deletion-query target merged from committed State Feed items. */
    deletionTargetSeq: integer().default(0).notNull(),
    /** Greatest source message seq durably scanned by forward message queries. */
    messageProcessedThroughSeq: integer().default(0).notNull(),
    /** Greatest source deletion seq durably scanned by forward tombstone queries. */
    deletionProcessedThroughSeq: integer().default(0).notNull(),
    /** Frozen deletion target for a reauthorization recovery drain. */
    deletionRecoveryThroughSeq: integer(),
    /** Frozen message cutoff paired with deletionRecoveryThroughSeq. */
    deletionRecoveryMaxMessageSeq: integer(),
    /** MessageThread authorization epoch under which this state was initialized. */
    authorizationEpoch: integer().default(0).notNull(),
    /** Recoverable historical interval currently selected for reverse reconstruction. */
    activeGapId: bigint({ mode: 'bigint' }),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.threadId, table.namespaceId],
      name: 'FederationThreadSyncState_pkey',
    }),
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'FederationThreadSyncState_namespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'FederationThreadSyncState_threadId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.threadId, table.namespaceId, table.activeGapId],
      foreignColumns: [
        federationThreadHistoryGap.threadId,
        federationThreadHistoryGap.namespaceId,
        federationThreadHistoryGap.id,
      ],
      name: 'FederationThreadSyncState_activeGap_fkey',
    }).onDelete('restrict'),
    check(
      'FederationThreadSyncState_messageSeqs_check',
      sql`${table.messageTargetSeq} >= 0
        AND ${table.deletionTargetSeq} >= 0
        AND ${table.messageProcessedThroughSeq} >= 0
        AND ${table.deletionProcessedThroughSeq} >= 0
        AND ${table.messageProcessedThroughSeq} <= ${table.messageTargetSeq}
        AND ${table.deletionProcessedThroughSeq} <= ${table.deletionTargetSeq}
        AND ${table.authorizationEpoch} >= 0`,
    ),
    check(
      'FederationThreadSyncState_deletionRecovery_check',
      sql`(
          ${table.deletionRecoveryThroughSeq} IS NULL
          AND ${table.deletionRecoveryMaxMessageSeq} IS NULL
        ) OR (
          ${table.deletionRecoveryThroughSeq} IS NOT NULL
          AND ${table.deletionRecoveryMaxMessageSeq} IS NOT NULL
          AND ${table.deletionRecoveryThroughSeq} > ${table.deletionProcessedThroughSeq}
          AND ${table.deletionRecoveryThroughSeq} <= ${table.deletionTargetSeq}
          AND ${table.deletionRecoveryMaxMessageSeq} >= 0
        )`,
    ),
  ],
);

export const loginCode = pgTable(
  'LoginCode',
  {
    id: serial().primaryKey().notNull(),
    userId: integer().notNull(),
    codeHash: varchar({ length: 127 }).notNull(),
    issuedBy: integer().notNull(),
    issuedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    expiresAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    consumedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    consumedIp: varchar({ length: 64 }),
    consumedDevice: varchar({ length: 127 }),
    producedSessionId: integer(),
    revokedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
  },
  (table) => [
    index('LoginCode_userId_idx').using(
      'btree',
      table.userId.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'LoginCode_userId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const sessionToken = pgTable(
  'SessionToken',
  {
    id: serial().primaryKey().notNull(),
    userId: integer().notNull(),
    tokenHash: varchar({ length: 127 }).notNull(),
    device: varchar({ length: 127 }),
    userAgent: varchar({ length: 255 }),
    ip: varchar({ length: 64 }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    expiresAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    lastSeenAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    revokedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    revokeReason: varchar({ length: 32 }),
    client: varchar({ length: 16 }).notNull(),
    lastSeenIp: varchar({ length: 64 }),
    autoTerminateDays: integer().default(30).notNull(),
    pushSubscriptionRev: integer().default(1).notNull(),
    pushToken: varchar({ length: 512 }),
    pushPlatform: pushPlatform(),
    pushDeviceId: varchar({ length: 127 }),
    pushP256dh: varchar({ length: 255 }),
    pushAuth: varchar({ length: 255 }),
    pushRegisteredAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
  },
  (table) => [
    index('SessionToken_lastSeenAt_active_idx')
      .using(
        'btree',
        table.lastSeenAt.desc().nullsFirst().op('timestamptz_ops'),
      )
      .where(sql`("revokedAt" IS NULL)`),
    uniqueIndex('SessionToken_pushToken_key')
      .on(table.pushToken)
      .where(sql`${table.pushToken} IS NOT NULL`),
    check(
      'SessionToken_pushSubscriptionRev_check',
      sql`${table.pushSubscriptionRev} > 0`,
    ),
    check(
      'SessionToken_push_shape_check',
      sql`(
      (${table.pushToken} IS NULL AND ${table.pushPlatform} IS NULL AND ${table.pushP256dh} IS NULL AND ${table.pushAuth} IS NULL AND ${table.pushRegisteredAt} IS NULL)
      OR (${table.pushToken} IS NOT NULL AND ${table.pushPlatform} IS NOT NULL AND ${table.pushRegisteredAt} IS NOT NULL AND (
        (${table.pushPlatform} = 'WEB' AND ${table.pushP256dh} IS NOT NULL AND ${table.pushAuth} IS NOT NULL)
        OR (${table.pushPlatform} <> 'WEB' AND ${table.pushP256dh} IS NULL AND ${table.pushAuth} IS NULL)
      ))
    )`,
    ),
    uniqueIndex('SessionToken_tokenHash_key').using(
      'btree',
      table.tokenHash.asc().nullsLast().op('text_ops'),
    ),
    index('SessionToken_userId_idx').using(
      'btree',
      table.userId.asc().nullsLast().op('int4_ops'),
    ),
    index('SessionToken_userId_lastSeenAt_active_idx')
      .using(
        'btree',
        table.userId.asc().nullsLast().op('int4_ops'),
        table.lastSeenAt.desc().nullsFirst().op('timestamptz_ops'),
      )
      .where(sql`("revokedAt" IS NULL)`),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'SessionToken_userId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check(
      'SessionToken_auto_terminate_days_check',
      sql`${table.autoTerminateDays} IN (7, 30, 90, 180, 365)`,
    ),
  ],
);

export const twoFactorBackupCode = pgTable(
  'TwoFactorBackupCode',
  {
    id: serial().primaryKey().notNull(),
    adminId: integer().notNull(),
    codeHash: varchar({ length: 64 }).notNull(),
    consumedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('TwoFactorBackupCode_adminId_codeHash_idx').using(
      'btree',
      table.adminId.asc().nullsLast().op('int4_ops'),
      table.codeHash.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.adminId],
      foreignColumns: [admin.id],
      name: 'TwoFactorBackupCode_adminId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const webAuthnCredential = pgTable(
  'WebAuthnCredential',
  {
    id: serial().primaryKey().notNull(),
    adminId: integer().notNull(),
    credentialId: varchar({ length: 510 }).notNull(),
    publicKey: bytea('publicKey').notNull(),
    counter: integer().default(0).notNull(),
    transports: text(),
    deviceType: varchar({ length: 32 }),
    backed: boolean().default(false).notNull(),
    nickname: varchar({ length: 64 }),
    lastUsedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('WebAuthnCredential_adminId_idx').using(
      'btree',
      table.adminId.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('WebAuthnCredential_credentialId_key').using(
      'btree',
      table.credentialId.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.adminId],
      foreignColumns: [admin.id],
      name: 'WebAuthnCredential_adminId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const adminLoginChallenge = pgTable(
  'AdminLoginChallenge',
  {
    jti: varchar({ length: 36 }).primaryKey().notNull(),
    adminId: integer().notNull(),
    consumedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('AdminLoginChallenge_createdAt_idx').using(
      'btree',
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    foreignKey({
      columns: [table.adminId],
      foreignColumns: [admin.id],
      name: 'AdminLoginChallenge_adminId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

export const diagnosticsReport = pgTable(
  'DiagnosticsReport',
  {
    id: serial().primaryKey().notNull(),
    reporterUserId: integer().notNull(),
    bundlePath: varchar({ length: 255 }).notNull(),
    bundleBytes: integer().notNull(),
    manifest: jsonb().notNull(),
    status: varchar({ length: 16 }).default('new').notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    isDeleted: boolean().default(false).notNull(),
  },
  (table) => [
    index('DiagnosticsReport_createdAt_idx').using(
      'btree',
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('DiagnosticsReport_reporterUserId_idx').using(
      'btree',
      table.reporterUserId.asc().nullsLast().op('int4_ops'),
    ),
    index('DiagnosticsReport_status_idx').using(
      'btree',
      table.status.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.reporterUserId],
      foreignColumns: [account.id],
      name: 'DiagnosticsReport_reporterUserId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const forwardBundleDependency = pgTable(
  'ForwardBundleDependency',
  {
    parentBundleId: varchar({ length: 26 }).notNull(),
    childBundleId: varchar({ length: 26 }).notNull(),
    ordinal: integer().notNull(),
  },
  (table) => [
    index('ForwardBundleDependency_childBundleId_idx').using(
      'btree',
      table.childBundleId.asc().nullsLast().op('text_ops'),
    ),
    uniqueIndex('ForwardBundleDependency_parentBundleId_ordinal_key').using(
      'btree',
      table.parentBundleId.asc().nullsLast().op('text_ops'),
      table.ordinal.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.childBundleId],
      foreignColumns: [forwardBundle.id],
      name: 'ForwardBundleDependency_childBundleId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      columns: [table.parentBundleId],
      foreignColumns: [forwardBundle.id],
      name: 'ForwardBundleDependency_parentBundleId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    primaryKey({
      columns: [table.parentBundleId, table.childBundleId],
      name: 'ForwardBundleDependency_pkey',
    }),
  ],
);

export const s2SKeyCache = pgTable(
  'S2SKeyCache',
  {
    domain: varchar({ length: 63 }).notNull(),
    namespaceId: integer().notNull(),
    keyId: varchar({ length: 127 }).notNull(),
    publicKey: varchar({ length: 127 }).notNull(),
    /** Authorizing root public key of the cached certificate; MUST equal the
     *  pinned root of the namespace for the certificate to authenticate. */
    root: varchar({ length: 44 }).notNull(),
    notBefore: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    notAfter: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    authorizationSignature: varchar({ length: 127 }).notNull(),
    fetchedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.namespaceId, table.keyId],
      name: 'S2SKeyCache_pkey',
    }),
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'S2SKeyCache_namespace_fkey',
    }).onDelete('restrict'),
  ],
);

export const quotaDailyUsage = pgTable(
  'QuotaDailyUsage',
  {
    namespaceId: integer().notNull(),
    date: date({ mode: 'date' }).notNull(),
    category: varchar({ length: 15 }).notNull(),
    count: integer().default(0).notNull(),
  },
  (table) => [
    index('QuotaDailyUsage_date_idx').using(
      'btree',
      table.date.asc().nullsLast().op('date_ops'),
    ),
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'QuotaDailyUsage_namespaceId_fkey',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.namespaceId, table.date, table.category],
      name: 'QuotaDailyUsage_pkey',
    }),
  ],
);

export const userQuotaPolicy = pgTable(
  'UserQuotaPolicy',
  {
    userId: integer().primaryKey().notNull(),
    dailyMsgLimit: integer(),
    dailyRequestLimit: integer(),
    // Quota circuit-breaker file dimensions (daily). All file types consolidate into a single file cnt + file
    // total size; bundles count +1 file cnt and 0 bytes. null = use the global default.
    dailyFileLimit: integer(),
    dailyFileBytesLimit: bigint({ mode: 'bigint' }),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'UserQuotaPolicy_userId_fkey',
    }).onDelete('cascade'),
  ],
);

export const userQuotaDailyUsage = pgTable(
  'UserQuotaDailyUsage',
  {
    userId: integer().notNull(),
    date: date({ mode: 'date' }).notNull(),
    category: varchar({ length: 15 }).notNull(),
    count: integer().default(0).notNull(),
  },
  (table) => [
    index('UserQuotaDailyUsage_date_idx').using(
      'btree',
      table.date.asc().nullsLast().op('date_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'UserQuotaDailyUsage_userId_fkey',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.userId, table.date, table.category],
      name: 'UserQuotaDailyUsage_pkey',
    }),
  ],
);

/**
 * Daily file-total-size accumulator for a federated peer (bigint — count tables above are integer). One row per
 * (namespaceId, UTC day). The file-cnt dimension reuses QuotaDailyUsage with category 'files'; the byte
 * dimension lives here because byte totals exceed integer range. Drives the per-namespace circuit breaker.
 */
export const quotaFileByteUsage = pgTable(
  'QuotaFileByteUsage',
  {
    namespaceId: integer().notNull(),
    date: date({ mode: 'date' }).notNull(),
    bytes: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
  },
  (table) => [
    index('QuotaFileByteUsage_date_idx').using(
      'btree',
      table.date.asc().nullsLast().op('date_ops'),
    ),
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'QuotaFileByteUsage_namespaceId_fkey',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.namespaceId, table.date],
      name: 'QuotaFileByteUsage_pkey',
    }),
  ],
);

/**
 * Daily file-total-size accumulator for a local user (bigint). One row per (userId, UTC day). Drives the per-user
 * circuit breaker. See src/quota/user-quota.service.ts.
 */
export const userQuotaFileByteUsage = pgTable(
  'UserQuotaFileByteUsage',
  {
    userId: integer().notNull(),
    date: date({ mode: 'date' }).notNull(),
    bytes: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
  },
  (table) => [
    index('UserQuotaFileByteUsage_date_idx').using(
      'btree',
      table.date.asc().nullsLast().op('date_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'UserQuotaFileByteUsage_userId_fkey',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.userId, table.date],
      name: 'UserQuotaFileByteUsage_pkey',
    }),
  ],
);

/**
 * Admin "continue / add quota": a per-(namespaceId, UTC-day) ADDITIVE allowance on top of the base limit.
 * The effective breaker limit for today = base (override ?? default) + extra*. Persisted across restarts;
 * auto-resets via the date key.
 */
export const quotaDailyAllowance = pgTable(
  'QuotaDailyAllowance',
  {
    namespaceId: integer().notNull(),
    date: date({ mode: 'date' }).notNull(),
    extraMsg: integer().default(0).notNull(),
    extraFile: integer().default(0).notNull(),
    extraFileBytes: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'QuotaDailyAllowance_namespaceId_fkey',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.namespaceId, table.date],
      name: 'QuotaDailyAllowance_pkey',
    }),
  ],
);

/** Per-(userId, UTC-day) additive allowance — local-user counterpart of QuotaDailyAllowance. */
export const userQuotaDailyAllowance = pgTable(
  'UserQuotaDailyAllowance',
  {
    userId: integer().notNull(),
    date: date({ mode: 'date' }).notNull(),
    extraMsg: integer().default(0).notNull(),
    extraFile: integer().default(0).notNull(),
    extraFileBytes: bigint({ mode: 'bigint' })
      .default(sql`0`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'UserQuotaDailyAllowance_userId_fkey',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.userId, table.date],
      name: 'UserQuotaDailyAllowance_pkey',
    }),
  ],
);

export const forwardBundleAsset = pgTable(
  'ForwardBundleAsset',
  {
    bundleId: varchar({ length: 26 }).notNull(),
    digest: varchar({ length: 64 }).notNull(),
    ordinal: integer().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    bytes: bigint({ mode: 'bigint' }).notNull(),
  },
  (table) => [
    uniqueIndex('ForwardBundleAsset_bundleId_digest_key').using(
      'btree',
      table.bundleId.asc().nullsLast().op('text_ops'),
      table.digest.asc().nullsLast().op('text_ops'),
    ),
    index('ForwardBundleAsset_digest_idx').using(
      'btree',
      table.digest.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.bundleId],
      foreignColumns: [forwardBundle.id],
      name: 'ForwardBundleAsset_bundleId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    primaryKey({
      columns: [table.bundleId, table.ordinal],
      name: 'ForwardBundleAsset_pkey',
    }),
  ],
);

/** Local call observations retained until their terminal system notice is committed. */
export const callHistory = pgTable(
  'CallHistory',
  {
    key: text().primaryKey(),
    threadId: integer()
      .notNull()
      .references(() => messageThread.id, { onDelete: 'cascade' }),
    snapshot: jsonb().$type<Record<string, unknown>>().notNull(),
    revision: integer().notNull(),
    terminal: boolean().default(false).notNull(),
    messageSeq: integer(),
  },
  (table) => [
    index('CallHistory_pending_idx')
      .on(table.terminal)
      .where(sql`${table.messageSeq} IS NULL`),
  ],
);
