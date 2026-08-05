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
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

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
export const contentType = pgEnum('ContentType', [
  'PURE_TEXT',
  'INVITE',
  'IMAGE',
  'VIDEO',
  'FILE',
  'AUDIO',
  'LINK',
  'CALL',
  'FORWARD',
]);
export const groupRole = pgEnum('GroupRole', ['OWNER', 'ADMIN', 'MEMBER']);
export const inviteKind = pgEnum('InviteKind', ['FRIEND', 'GROUP']);
export const inviteStatus = pgEnum('InviteStatus', [
  'PENDING',
  'ACCEPTED',
  'REJECTED',
  'REVOKED',
  'EXPIRED',
]);
export const messageThreadType = pgEnum('MessageThreadType', ['P2P', 'GROUP']);
export const pushPlatform = pgEnum('PushPlatform', ['ANDROID', 'WEB', 'IOS']);
export const mediaAssetStatus = pgEnum('MediaAssetStatus', [
  'PENDING',
  'READY',
  'FAILED',
  'DELETING',
  'DELETED',
]);
export const uploadSessionStatus = pgEnum('UploadSessionStatus', [
  'UPLOADING',
  'COMPLETING',
  'COMPLETED',
  'ABORTED',
]);
export const threadRevisionDirection = pgEnum('ThreadRevisionDirection', [
  'ADD',
  'DELETE',
]);
export const messageDeleteType = pgEnum('MessageDeleteType', [
  'WITHDRAW',
  'REPORT',
]);

export const adminSession = pgTable(
  'AdminSession',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    adminId: integer().notNull(),
    tokenHash: text().notNull(),
    userAgent: varchar({ length: 255 }),
    ip: varchar({ length: 64 }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    lastAccessedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    expiresAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    revokedAt: timestamp({ precision: 3, mode: 'date' }),
    revokeReason: varchar({ length: 32 }),
  },
  (table) => [
    index('AdminSession_adminId_idx').using(
      'btree',
      table.adminId.asc().nullsLast().op('int4_ops'),
    ),
    index('AdminSession_expiresAt_idx').using(
      'btree',
      table.expiresAt.asc().nullsLast().op('timestamp_ops'),
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
    schemaVersion: integer().default(1).notNull(),
    depth: integer().notNull(),
    manifest: jsonb().notNull(),
    manifestDigest: varchar({ length: 64 }).notNull(),
    messageCount: integer().notNull(),
    assetCount: integer().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    totalBytes: bigint({ mode: 'bigint' }).notNull(),
    sourceDomain: varchar({ length: 63 }),
    sourceBundleId: varchar({ length: 26 }),
    createdBy: integer(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('ForwardBundle_createdBy_idx').using(
      'btree',
      table.createdBy.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('ForwardBundle_sourceDomain_sourceBundleId_key').using(
      'btree',
      table.sourceDomain.asc().nullsLast().op('text_ops'),
      table.sourceBundleId.asc().nullsLast().op('text_ops'),
    ),
    check('ForwardBundle_asset_count_check', sql`"assetCount" >= 0`),
    check('ForwardBundle_depth_check', sql`(depth >= 1) AND (depth <= 3)`),
    check(
      'ForwardBundle_manifest_shape_check',
      sql`(jsonb_typeof(manifest) = 'object'::text) AND (jsonb_typeof((manifest -> 'children'::text)) = 'array'::text) AND (jsonb_typeof((manifest -> 'messages'::text)) = 'array'::text) AND (((manifest ->> 'schemaVersion'::text))::integer = 1)`,
    ),
    check(
      'ForwardBundle_message_count_check',
      sql`("messageCount" >= 1) AND ("messageCount" <= 100)`,
    ),
    check('ForwardBundle_schema_version_check', sql`"schemaVersion" = 1`),
    check('ForwardBundle_total_bytes_check', sql`"totalBytes" >= 0`),
  ],
);

export const user = pgTable(
  'User',
  {
    id: serial().primaryKey().notNull(),
    account: varchar({ length: 31 }).notNull(),
    hashPwd: varchar({ length: 127 }),
    name: text().notNull(),
    avatar: text().default('').notNull(),
    bio: varchar({ length: 255 }).default('').notNull(),
    isForeigner: boolean().notNull(),
    isGroup: boolean().default(false).notNull(),
    domain: varchar({ length: 63 }).default('local').notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    isDeleted: boolean().default(false).notNull(),
    profileRev: integer().default(0).notNull(),
    remoteProfileRev: integer(),
    threadRevision: integer().default(0).notNull(),
    readRevision: integer().default(0).notNull(),
    mustChangePassword: boolean().default(false).notNull(),
    friendReqAckRev: timestamp({ precision: 3, mode: 'date' })
      .default(sql`'1970-01-01 00:00:00'`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('User_account_domain_key').using(
      'btree',
      table.account.asc().nullsLast().op('text_ops'),
      table.domain.asc().nullsLast().op('text_ops'),
    ),
    check(
      'User_isGroup_sigil_check',
      sql`((account)::text ~~ '!%'::text) = "isGroup"`,
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
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.key] }),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
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

export const threadParticipant = pgTable(
  'ThreadParticipant',
  {
    id: serial().primaryKey().notNull(),
    userId: integer().notNull(),
    threadId: integer().notNull(),
    lastReadSeq: integer(),
    readRevision: integer().default(0).notNull(),
    role: groupRole(),
    joinedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    muted: boolean().default(false).notNull(),
    pinned: boolean().default(false).notNull(),
    pinnedAt: timestamp({ precision: 3, mode: 'date' }),
    clearedSeq: integer(),
    alias: varchar({ length: 64 }),
    leftAt: timestamp({ precision: 3, mode: 'date' }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
  },
  (table) => [
    index('ThreadParticipant_threadId_idx').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
    ),
    index('ThreadParticipant_threadId_joinedAt_active_idx')
      .using(
        'btree',
        table.threadId.asc().nullsLast().op('int4_ops'),
        table.joinedAt.asc().nullsLast().op('int4_ops'),
      )
      .where(sql`("leftAt" IS NULL)`),
    index('ThreadParticipant_userId_pinned_idx').using(
      'btree',
      table.userId.asc().nullsLast().op('int4_ops'),
      table.pinned.asc().nullsLast().op('bool_ops'),
    ),
    index('ThreadParticipant_userId_readRevision_idx').using(
      'btree',
      table.userId.asc().nullsLast().op('int4_ops'),
      table.readRevision.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('ThreadParticipant_userId_threadId_key').using(
      'btree',
      table.userId.asc().nullsLast().op('int4_ops'),
      table.threadId.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'ThreadParticipant_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'ThreadParticipant_userId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    check(
      'ThreadParticipant_cleared_seq_check',
      sql`${table.clearedSeq} IS NULL OR ${table.clearedSeq} >= -1`,
    ),
  ],
);

export const messageThread = pgTable(
  'MessageThread',
  {
    id: serial().primaryKey().notNull(),
    type: messageThreadType().notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    curSeq: integer()
      .default(sql`'-1'`)
      .notNull(),
    lastMessageSeq: integer(),
    lastMessagePreview: varchar({ length: 255 }),
    lastMessageAt: timestamp({ precision: 3, mode: 'date' }),
    groupUserId: integer(),
    pullUntil: integer()
      .default(sql`'-1'`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('MessageThread_groupUserId_key').using(
      'btree',
      table.groupUserId.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.groupUserId],
      foreignColumns: [user.id],
      name: 'MessageThread_groupUserId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'MessageThread_groupUserId_type_check',
      sql`(type = 'P2P'::"MessageThreadType") = ("groupUserId" IS NULL)`,
    ),
  ],
);

export const messageAsset = pgTable(
  'MessageAsset',
  {
    messageId: bigint({ mode: 'bigint' }).notNull(),
    threadId: integer().notNull(),
    digest: varchar({ length: 64 }).notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
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

export const mediaAsset = pgTable(
  'MediaAsset',
  {
    digest: varchar({ length: 64 }).primaryKey().notNull(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    bytes: bigint({ mode: 'bigint' }).notNull(),
    status: mediaAssetStatus().default('READY').notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    stateChangedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('MediaAsset_status_createdAt_idx').using(
      'btree',
      table.status.asc().nullsLast().op('enum_ops'),
      table.stateChangedAt.asc().nullsLast().op('timestamp_ops'),
    ),
  ],
);

/** Server-maintained hostname allowlist for client-derived cards. Message content is never rewritten. */
export const linkCardRule = pgTable(
  'LinkCardRule',
  {
    id: serial().primaryKey().notNull(),
    hostname: varchar({ length: 255 }).notNull(),
    note: varchar({ length: 100 }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('LinkCardRule_hostname_key').using(
      'btree',
      table.hostname.asc(),
    ),
  ],
);

export const userBlock = pgTable(
  'UserBlock',
  {
    id: serial().primaryKey().notNull(),
    blockerId: integer().notNull(),
    blockedId: integer().notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('UserBlock_blockedId_idx').using(
      'btree',
      table.blockedId.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('UserBlock_blockerId_blockedId_key').using(
      'btree',
      table.blockerId.asc().nullsLast().op('int4_ops'),
      table.blockedId.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.blockedId],
      foreignColumns: [user.id],
      name: 'UserBlock_blockedId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      columns: [table.blockerId],
      foreignColumns: [user.id],
      name: 'UserBlock_blockerId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const message = pgTable(
  'Message',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    seq: integer().notNull(),
    contentType: contentType().notNull(),
    content: jsonbText().notNull(),
    threadId: integer().notNull(),
    creator: integer().notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    isDeleted: boolean().default(false).notNull(),
    clientMessageId: varchar({ length: 36 }),
    originSeq: integer(),
    originServerTime: timestamp({ precision: 3, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('Message_clientMessageId_key').using(
      'btree',
      table.clientMessageId.asc().nullsLast().op('text_ops'),
    ),
    index('Message_createdAt_idx').using(
      'btree',
      table.createdAt.asc().nullsLast().op('timestamp_ops'),
    ),
    index('Message_creator_idx').using(
      'btree',
      table.creator.asc().nullsLast().op('int4_ops'),
    ),
    index('Message_threadId_createdAt_idx').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.createdAt.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('Message_threadId_creator_originSeq_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.creator.asc().nullsLast().op('int4_ops'),
      table.originSeq.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('Message_threadId_seq_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.seq.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.creator],
      foreignColumns: [user.id],
      name: 'Message_creator_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
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
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    threadId: integer().notNull(),
    seq: integer().notNull(),
    type: messageDeleteType().notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('DeletedMessage_threadId_seq_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.seq.asc().nullsLast().op('int4_ops'),
    ),
    index('DeletedMessage_threadId_id_idx').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.id.asc().nullsLast().op('int8_ops'),
    ),
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
 * the stable cross-server identity (thread, creator, originSeq). */
export const federatedMessageTombstone = pgTable(
  'FederatedMessageTombstone',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    threadId: integer().notNull(),
    creatorId: integer().notNull(),
    originSeq: integer().notNull(),
    authorityDomain: varchar({ length: 255 }).notNull(),
    sourceDomain: varchar({ length: 255 }).notNull(),
    remoteDeletedId: bigint({ mode: 'bigint' }).notNull(),
    type: messageDeleteType().notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('FederatedMessageTombstone_target_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.creatorId.asc().nullsLast().op('int4_ops'),
      table.originSeq.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('FederatedMessageTombstone_source_event_key').using(
      'btree',
      table.sourceDomain.asc().nullsLast().op('text_ops'),
      table.remoteDeletedId.asc().nullsLast().op('int8_ops'),
    ),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'FederatedMessageTombstone_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      columns: [table.creatorId],
      foreignColumns: [user.id],
      name: 'FederatedMessageTombstone_creatorId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

/** One cursor per ordered remote deletion stream. A thread can have several streams (notably a group
 * origin pulling author servers), hence this is not a MessageThread column. */
export const federationDeletedCursor = pgTable(
  'FederationDeletedCursor',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    threadId: integer().notNull(),
    peerDomain: varchar({ length: 255 }).notNull(),
    streamAccount: varchar({ length: 255 }).default('').notNull(),
    streamKind: varchar({ length: 32 }).notNull(),
    deletedHwm: bigint({ mode: 'bigint' }).default(0n).notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('FederationDeletedCursor_stream_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.peerDomain.asc().nullsLast().op('text_ops'),
      table.streamAccount.asc().nullsLast().op('text_ops'),
      table.streamKind.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'FederationDeletedCursor_threadId_fkey',
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
    lastLoginAt: timestamp({ precision: 3, mode: 'date' }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    role: adminRole().default('SUPER_ADMIN').notNull(),
    twoFactorEnabled: boolean().default(false).notNull(),
    twoFactorSecretCipher: varchar({ length: 255 }),
    twoFactorEnabledAt: timestamp({ precision: 3, mode: 'date' }),
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
      foreignColumns: [user.id],
      name: 'Admin_userId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const federatedPeerEvent = pgTable(
  'FederatedPeerEvent',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    domain: varchar({ length: 63 }).notNull(),
    type: varchar({ length: 15 }).notNull(),
    reason: varchar({ length: 255 }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('FederatedPeerEvent_createdAt_idx').using(
      'btree',
      table.createdAt.asc().nullsLast().op('timestamp_ops'),
    ),
    index('FederatedPeerEvent_domain_createdAt_idx').using(
      'btree',
      table.domain.asc().nullsLast().op('text_ops'),
      table.createdAt.asc().nullsLast().op('text_ops'),
    ),
  ],
);

export const pushToken = pgTable(
  'PushToken',
  {
    id: serial().primaryKey().notNull(),
    userId: integer().notNull(),
    token: varchar({ length: 500 }).notNull(),
    deviceId: varchar({ length: 127 }),
    platform: pushPlatform().notNull(),
    webP256dh: varchar('webP256dh', { length: 255 }),
    webAuth: varchar({ length: 255 }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    lastSeenAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('PushToken_token_key').using(
      'btree',
      table.token.asc().nullsLast().op('text_ops'),
    ),
    index('PushToken_userId_idx').using(
      'btree',
      table.userId.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'PushToken_userId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const invite = pgTable(
  'Invite',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    kind: inviteKind().notNull(),
    fromUserId: integer().notNull(),
    toUserId: integer().notNull(),
    threadId: integer(),
    note: varchar({ length: 255 }).default('').notNull(),
    status: inviteStatus().default('PENDING').notNull(),
    expiresAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    origin: varchar({ length: 63 }).notNull(),
    originId: varchar({ length: 127 }).notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
  },
  (table) => [
    index('Invite_fromUserId_status_kind_idx').using(
      'btree',
      table.fromUserId.asc().nullsLast().op('int4_ops'),
      table.status.asc().nullsLast().op('int4_ops'),
      table.kind.asc().nullsLast().op('enum_ops'),
    ),
    index('Invite_incoming_friend_pending_createdAt_idx')
      .using(
        'btree',
        table.toUserId.asc().nullsLast().op('int4_ops'),
        table.createdAt.desc().nullsFirst().op('int4_ops'),
      )
      .where(
        sql`((kind = 'FRIEND'::"InviteKind") AND (status = 'PENDING'::"InviteStatus"))`,
      ),
    index('Invite_kind_threadId_toUserId_status_idx').using(
      'btree',
      table.kind.asc().nullsLast().op('enum_ops'),
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.toUserId.asc().nullsLast().op('int4_ops'),
      table.status.asc().nullsLast().op('enum_ops'),
    ),
    uniqueIndex('Invite_origin_originId_key').using(
      'btree',
      table.origin.asc().nullsLast().op('text_ops'),
      table.originId.asc().nullsLast().op('text_ops'),
    ),
    index('Invite_outgoing_friend_pending_createdAt_idx')
      .using(
        'btree',
        table.fromUserId.asc().nullsLast().op('int4_ops'),
        table.createdAt.desc().nullsFirst().op('int4_ops'),
      )
      .where(
        sql`((kind = 'FRIEND'::"InviteKind") AND (status = 'PENDING'::"InviteStatus"))`,
      ),
    index('Invite_toUserId_status_kind_idx').using(
      'btree',
      table.toUserId.asc().nullsLast().op('int4_ops'),
      table.status.asc().nullsLast().op('int4_ops'),
      table.kind.asc().nullsLast().op('enum_ops'),
    ),
    uniqueIndex('invite_friend_pending_uq')
      .using(
        'btree',
        table.fromUserId.asc().nullsLast().op('int4_ops'),
        table.toUserId.asc().nullsLast().op('int4_ops'),
      )
      .where(
        sql`((kind = 'FRIEND'::"InviteKind") AND (status = 'PENDING'::"InviteStatus") AND ("threadId" IS NULL))`,
      ),
    uniqueIndex('invite_group_pending_uq')
      .using(
        'btree',
        table.toUserId.asc().nullsLast().op('int4_ops'),
        table.threadId.asc().nullsLast().op('int4_ops'),
      )
      .where(
        sql`((kind = 'GROUP'::"InviteKind") AND (status = 'PENDING'::"InviteStatus"))`,
      ),
    foreignKey({
      columns: [table.fromUserId],
      foreignColumns: [user.id],
      name: 'Invite_fromUserId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'Invite_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('set null'),
    foreignKey({
      columns: [table.toUserId],
      foreignColumns: [user.id],
      name: 'Invite_toUserId_fkey',
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
    success: boolean().default(true).notNull(),
    errorMessage: varchar({ length: 255 }),
    meta: jsonb(),
    at: timestamp({ precision: 3, mode: 'date' })
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
      table.at.asc().nullsLast().op('timestamp_ops'),
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
    threadId: integer().notNull(),
    creatorId: integer().notNull(),
    contentType: contentType().notNull(),
    content: text().notNull(),
    digest: varchar({ length: 64 }),
    clientMessageId: varchar({ length: 36 }),
    originSeq: integer(),
    status: varchar({ length: 12 }).default('pending').notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    failReason: varchar({ length: 255 }),
  },
  (table) => [
    uniqueIndex('PendingMedia_clientMessageId_key').using(
      'btree',
      table.clientMessageId.asc().nullsLast().op('text_ops'),
    ),
    index('PendingMedia_status_createdAt_idx').using(
      'btree',
      table.status.asc().nullsLast().op('text_ops'),
      table.createdAt.asc().nullsLast().op('timestamp_ops'),
    ),
    uniqueIndex('PendingMedia_threadId_creatorId_originSeq_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.creatorId.asc().nullsLast().op('int4_ops'),
      table.originSeq.asc().nullsLast().op('int4_ops'),
    ),
    index('PendingMedia_threadId_idx').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
    ),
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
    creatorId: integer().notNull(),
    contentType: contentType().notNull(),
    originalName: varchar({ length: 100 }).notNull(),
    mimeType: varchar({ length: 255 }).notNull(),
    totalBytes: bigint({ mode: 'bigint' }).notNull(),
    receivedBytes: bigint({ mode: 'bigint' }).default(0n).notNull(),
    status: uploadSessionStatus().default('UPLOADING').notNull(),
    tmpKey: uuid().defaultRandom().notNull(),
    digest: varchar({ length: 64 }),
    result: jsonb(),
    errorReason: varchar({ length: 255 }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    completedAt: timestamp({ precision: 3, mode: 'date' }),
    abortedAt: timestamp({ precision: 3, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('UploadSession_uploadId_key').on(table.uploadId),
    uniqueIndex('UploadSession_clientMessageId_key').on(table.clientMessageId),
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
      foreignColumns: [user.id],
      name: 'UploadSession_creatorId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
  ],
);

export const group = pgTable(
  'Group',
  {
    id: serial().primaryKey().notNull(),
    groupUserId: integer().notNull(),
    ownerId: integer().notNull(),
    rosterRev: integer().default(0).notNull(),
    remoteRosterRev: integer(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    dissolvedAt: timestamp({ precision: 3, mode: 'date' }),
  },
  (table) => [
    uniqueIndex('Group_groupUserId_key').using(
      'btree',
      table.groupUserId.asc().nullsLast().op('int4_ops'),
    ),
    index('Group_ownerId_idx').using(
      'btree',
      table.ownerId.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.groupUserId],
      foreignColumns: [user.id],
      name: 'Group_groupUserId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

export const threadRevision = pgTable(
  'ThreadRevision',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    userId: integer().notNull(),
    threadId: integer().notNull(),
    direction: threadRevisionDirection().notNull(),
    revision: integer().notNull(),
    isDelete: boolean().default(false).notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('ThreadRevision_userId_revision_idx').using(
      'btree',
      table.userId.asc().nullsLast().op('int4_ops'),
      table.revision.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('ThreadRevision_userId_threadId_direction_key').using(
      'btree',
      table.userId.asc().nullsLast().op('enum_ops'),
      table.threadId.asc().nullsLast().op('enum_ops'),
      table.direction.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'ThreadRevision_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'ThreadRevision_userId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
  ],
);

export const systemSetting = pgTable('SystemSetting', {
  key: varchar({ length: 63 }).primaryKey().notNull(),
  value: text().notNull(),
  updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
});

/** Non-secret anchor for this installation's immutable federation identity. The private root key stays
 * on disk; this row detects a missing/replaced key file and a changed SOMS_DOMAIN before S2S resumes. */
export const localFederationIdentity = pgTable(
  'LocalFederationIdentity',
  {
    domain: varchar({ length: 63 }).primaryKey().notNull(),
    identityEpoch: integer().default(1).notNull(),
    rootKeyFingerprint: varchar({ length: 80 }).notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    check(
      'LocalFederationIdentity_identityEpoch_check',
      sql`${table.identityEpoch} > 0`,
    ),
  ],
);

export const federatedPeer = pgTable(
  'FederatedPeer',
  {
    domain: varchar({ length: 63 }).primaryKey().notNull(),
    trustLevel: varchar({ length: 15 }).default('pending').notNull(),
    addedBy: varchar({ length: 31 }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    trustedAt: timestamp({ precision: 3, mode: 'date' }),
    lastSuccessAt: timestamp({ precision: 3, mode: 'date' }),
    demotedAt: timestamp({ precision: 3, mode: 'date' }),
    demoteReason: varchar({ length: 255 }),
    demotionCount: integer().default(0).notNull(),
    blockedAt: timestamp({ precision: 3, mode: 'date' }),
    dailyMsgLimit: integer(),
    dailyImageLimit: integer(),
    dailyLargeFileLimit: integer(),
    dailyRequestLimit: integer(),
    maxImageBytes: integer(),
    maxLargeFileBytes: integer(),
    pairwiseServerId: varchar({ length: 64 }),
    rootKeyFingerprint: varchar({ length: 80 }),
    identityEpoch: integer(),
    identityPinnedAt: timestamp({ precision: 3, mode: 'date' }),
    identityLostAt: timestamp({ precision: 3, mode: 'date' }),
    identityLostReason: varchar({ length: 255 }),
    resetGeneration: integer().default(0).notNull(),
    resetAt: timestamp({ precision: 3, mode: 'date' }),
  },
  (table) => [
    check(
      'FederatedPeer_identityEpoch_check',
      sql`${table.identityEpoch} IS NULL OR ${table.identityEpoch} > 0`,
    ),
    index('FederatedPeer_lastSuccessAt_idx').using(
      'btree',
      table.lastSuccessAt.asc().nullsLast().op('timestamp_ops'),
    ),
    index('FederatedPeer_trustLevel_idx').using(
      'btree',
      table.trustLevel.asc().nullsLast().op('text_ops'),
    ),
  ],
);

/** Persistent replay protection for signed federation identity handshakes. */
export const s2SIdentityNonce = pgTable(
  'S2SIdentityNonce',
  {
    originDomain: varchar({ length: 63 }).notNull(),
    nonceHash: varchar({ length: 64 }).notNull(),
    issuedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    expiresAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.originDomain, table.nonceHash] }),
    index('S2SIdentityNonce_expiresAt_idx').using(
      'btree',
      table.expiresAt.asc().nullsLast().op('timestamp_ops'),
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
    issuedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    expiresAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    consumedAt: timestamp({ precision: 3, mode: 'date' }),
    consumedIp: varchar({ length: 64 }),
    consumedDevice: varchar({ length: 127 }),
    producedSessionId: integer(),
    revokedAt: timestamp({ precision: 3, mode: 'date' }),
  },
  (table) => [
    index('LoginCode_userId_idx').using(
      'btree',
      table.userId.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
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
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    expiresAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    lastSeenAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    revokedAt: timestamp({ precision: 3, mode: 'date' }),
    revokeReason: varchar({ length: 32 }),
    client: varchar({ length: 16 }).notNull(),
    lastSeenIp: varchar({ length: 64 }),
    autoTerminateDays: integer().default(30).notNull(),
  },
  (table) => [
    index('SessionToken_lastSeenAt_active_idx')
      .using('btree', table.lastSeenAt.desc().nullsFirst().op('timestamp_ops'))
      .where(sql`("revokedAt" IS NULL)`),
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
        table.lastSeenAt.desc().nullsFirst().op('timestamp_ops'),
      )
      .where(sql`("revokedAt" IS NULL)`),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
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
    consumedAt: timestamp({ precision: 3, mode: 'date' }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('TwoFactorBackupCode_adminId_codeHash_idx').using(
      'btree',
      table.adminId.asc().nullsLast().op('int4_ops'),
      table.codeHash.asc().nullsLast().op('int4_ops'),
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
    lastUsedAt: timestamp({ precision: 3, mode: 'date' }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
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
    consumedAt: timestamp({ precision: 3, mode: 'date' }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('AdminLoginChallenge_createdAt_idx').using(
      'btree',
      table.createdAt.asc().nullsLast().op('timestamp_ops'),
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
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
    isDeleted: boolean().default(false).notNull(),
  },
  (table) => [
    index('DiagnosticsReport_createdAt_idx').using(
      'btree',
      table.createdAt.asc().nullsLast().op('timestamp_ops'),
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
      foreignColumns: [user.id],
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

export const s2SFriendOpSeen = pgTable(
  'S2SFriendOpSeen',
  {
    origin: varchar({ length: 63 }).notNull(),
    opId: varchar({ length: 127 }).notNull(),
    receivedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.origin, table.opId],
      name: 'S2SFriendOpSeen_pkey',
    }),
  ],
);

export const s2SKeyCache = pgTable(
  'S2SKeyCache',
  {
    domain: varchar({ length: 63 }).notNull(),
    keyId: varchar({ length: 127 }).notNull(),
    publicKey: varchar({ length: 127 }).notNull(),
    fetchedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.domain, table.keyId],
      name: 'S2SKeyCache_pkey',
    }),
  ],
);

export const quotaDailyUsage = pgTable(
  'QuotaDailyUsage',
  {
    domain: varchar({ length: 63 }).notNull(),
    date: date({ mode: 'date' }).notNull(),
    category: varchar({ length: 15 }).notNull(),
    count: integer().default(0).notNull(),
  },
  (table) => [
    index('QuotaDailyUsage_date_idx').using(
      'btree',
      table.date.asc().nullsLast().op('date_ops'),
    ),
    primaryKey({
      columns: [table.domain, table.date, table.category],
      name: 'QuotaDailyUsage_pkey',
    }),
  ],
);

export const userQuotaPolicy = pgTable(
  'UserQuotaPolicy',
  {
    userId: integer().primaryKey().notNull(),
    dailyMsgLimit: integer(),
    dailyImageLimit: integer(),
    dailyLargeFileLimit: integer(),
    dailyRequestLimit: integer(),
    maxImageBytes: integer(),
    maxLargeFileBytes: integer(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
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
      foreignColumns: [user.id],
      name: 'UserQuotaDailyUsage_userId_fkey',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.userId, table.date, table.category],
      name: 'UserQuotaDailyUsage_pkey',
    }),
  ],
);

export const forwardBundleAsset = pgTable(
  'ForwardBundleAsset',
  {
    bundleId: varchar({ length: 26 }).notNull(),
    digest: varchar({ length: 64 }).notNull(),
    ordinal: integer().notNull(),
    kind: varchar({ length: 16 }).notNull(),
    extension: varchar({ length: 16 }).notNull(),
    filename: text(),
    mime: text(),
    // You can use { mode: "bigint" } if numbers are exceeding js number limitations
    bytes: bigint({ mode: 'bigint' }).notNull(),
  },
  (table) => [
    uniqueIndex('ForwardBundleAsset_bundleId_digest_kind_key').using(
      'btree',
      table.bundleId.asc().nullsLast().op('text_ops'),
      table.digest.asc().nullsLast().op('text_ops'),
      table.kind.asc().nullsLast().op('text_ops'),
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
