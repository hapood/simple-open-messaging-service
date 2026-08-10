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
  // Phase 7: multi-asset bundle. Appended last so ALTER TYPE ADD VALUE keeps enum sort order.
  'GALLERY',
  'SYSTEM',
]);
export const groupRole = pgEnum('GroupRole', ['OWNER', 'ADMIN', 'MEMBER']);
export const messageThreadType = pgEnum('MessageThreadType', ['P2P', 'GROUP']);
export const threadAudienceScope = pgEnum('ThreadAudienceScope', [
  'THREAD',
  'CREATOR',
]);
export const pushPlatform = pgEnum('PushPlatform', ['ANDROID', 'WEB', 'IOS']);
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
export const peerStateEventType = pgEnum('PeerStateEventType', [
  'PROFILE',
  'P2P_META',
  'GROUP_META',
  'GROUP_INVITE_INTENT',
  'GROUP_JOIN_INTENT',
]);
export const friendRequestStatus = pgEnum('FriendRequestStatus', [
  'REQUESTED',
  'FRIEND',
  'NOT_FRIEND',
]);
export const groupMembershipDirection = pgEnum('GroupMembershipDirection', [
  'INVITE',
  'JOIN',
]);
export const groupMembershipRequestStatus = pgEnum(
  'GroupMembershipRequestStatus',
  ['REQUESTED', 'MEMBER', 'NOT_MEMBER'],
);
export const messageDeleteType = pgEnum('MessageDeleteType', [
  'WITHDRAW',
  'REPORT',
]);
export const messageReportStatus = pgEnum('MessageReportStatus', [
  'PENDING',
  'UPHELD',
  'REJECTED',
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
  'BUNDLE',
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
    recognizesFriend: boolean().default(true).notNull(),
    relationshipRev: integer().default(0).notNull(),
    remoteRelationshipRev: integer(),
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
    check(
      'ThreadParticipant_relationship_rev_check',
      sql`${table.relationshipRev} >= 0 AND (${table.remoteRelationshipRev} IS NULL OR ${table.remoteRelationshipRev} >= 0)`,
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
    /** Federation reset completion marker. The retained thread shell is invisible after truncation. */
    federationTruncated: boolean().default(false).notNull(),
    /** Invalidates asynchronous federation responses captured before a completed thread cleanup. */
    federationVersion: integer().default(0).notNull(),
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
      sql`${table.federationTruncated} OR ((type = 'P2P'::"MessageThreadType") = ("groupUserId" IS NULL))`,
    ),
    check(
      'MessageThread_federationVersion_check',
      sql`${table.federationVersion} >= 0`,
    ),
  ],
);

/** Thread access and retained leave boundary shared by local users and federated peers. A null
 * deliverThroughChangeId is active; a non-null value closes discovery generation while preserving
 * already allocated changes through that inclusive id for draining and later reactivation. */
export const threadAudience = pgTable(
  'ThreadAudience',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    /** `local` addresses one local user; every other value addresses the whole federated peer domain. */
    targetDomain: varchar({ length: 63 }).notNull(),
    localUserId: integer(),
    threadId: integer().notNull(),
    scope: threadAudienceScope().default('THREAD').notNull(),
    creatorUserId: integer(),
    /** Inclusive per-target change boundary. Null means this audience may still produce changes. */
    deliverThroughChangeId: bigint({ mode: 'bigint' }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('ThreadAudience_local_key')
      .using(
        'btree',
        table.targetDomain.asc().nullsLast().op('text_ops'),
        table.localUserId.asc().nullsLast().op('int4_ops'),
        table.threadId.asc().nullsLast().op('int4_ops'),
      )
      .where(
        sql`${table.targetDomain} = 'local' AND ${table.scope} = 'THREAD'`,
      ),
    uniqueIndex('ThreadAudience_peer_key')
      .using(
        'btree',
        table.targetDomain.asc().nullsLast().op('text_ops'),
        table.threadId.asc().nullsLast().op('int4_ops'),
      )
      .where(
        sql`${table.targetDomain} <> 'local' AND ${table.scope} = 'THREAD'`,
      ),
    uniqueIndex('ThreadAudience_peer_creator_key')
      .using(
        'btree',
        table.targetDomain.asc().nullsLast().op('text_ops'),
        table.threadId.asc().nullsLast().op('int4_ops'),
        table.creatorUserId.asc().nullsLast().op('int4_ops'),
      )
      .where(sql`${table.scope} = 'CREATOR'`),
    index('ThreadAudience_local_access_idx')
      .using(
        'btree',
        table.localUserId.asc().nullsLast().op('int4_ops'),
        table.threadId.asc().nullsLast().op('int4_ops'),
      )
      .where(sql`${table.targetDomain} = 'local'`),
    index('ThreadAudience_peer_access_idx')
      .using(
        'btree',
        table.targetDomain.asc().nullsLast().op('text_ops'),
        table.threadId.asc().nullsLast().op('int4_ops'),
      )
      .where(sql`${table.targetDomain} <> 'local'`),
    index('ThreadAudience_creator_access_idx')
      .using(
        'btree',
        table.creatorUserId.asc().nullsLast().op('int4_ops'),
        table.threadId.asc().nullsLast().op('int4_ops'),
        table.deliverThroughChangeId.asc().nullsLast().op('int8_ops'),
      )
      .where(sql`${table.scope} = 'CREATOR'`),
    foreignKey({
      columns: [table.localUserId],
      foreignColumns: [user.id],
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
    foreignKey({
      columns: [table.creatorUserId],
      foreignColumns: [user.id],
      name: 'ThreadAudience_creatorUserId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'ThreadAudience_target_check',
      sql`(${table.targetDomain} = 'local' AND ${table.localUserId} IS NOT NULL) OR (${table.targetDomain} <> 'local' AND ${table.localUserId} IS NULL)`,
    ),
    check(
      'ThreadAudience_scope_check',
      sql`(${table.scope} = 'THREAD' AND ${table.creatorUserId} IS NULL) OR (${table.scope} = 'CREATOR' AND ${table.targetDomain} <> 'local' AND ${table.localUserId} IS NULL AND ${table.creatorUserId} IS NOT NULL)`,
    ),
    check(
      'ThreadAudience_deliverThroughChangeId_check',
      sql`${table.deliverThroughChangeId} IS NULL OR ${table.deliverThroughChangeId} >= 0`,
    ),
  ],
);

/** Transactional change-id allocator for one pull target. `local` identifies one local user; a real
 * domain identifies the whole remote federation server. Updating allocatedThrough row-locks only this
 * target, so unrelated users/peers do not serialize their message writes. */
export const discoveryTarget = pgTable(
  'DiscoveryTarget',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    targetDomain: varchar({ length: 63 }).notNull(),
    localUserId: integer(),
    allocatedThrough: bigint({ mode: 'bigint' }).default(0n).notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('DiscoveryTarget_local_key')
      .on(table.targetDomain, table.localUserId)
      .where(sql`${table.targetDomain} = 'local'`),
    uniqueIndex('DiscoveryTarget_peer_key')
      .on(table.targetDomain)
      .where(sql`${table.targetDomain} <> 'local'`),
    foreignKey({
      columns: [table.localUserId],
      foreignColumns: [user.id],
      name: 'DiscoveryTarget_localUserId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'DiscoveryTarget_identity_check',
      sql`(${table.targetDomain} = 'local' AND ${table.localUserId} IS NOT NULL) OR (${table.targetDomain} <> 'local' AND ${table.localUserId} IS NULL)`,
    ),
    check(
      'DiscoveryTarget_allocatedThrough_check',
      sql`${table.allocatedThrough} >= 0`,
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
    createdAt: timestamp({ precision: 3, mode: 'date' })
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

/** Server-maintained hostname allowlist for client-derived cards. Message content is never rewritten. */
export const linkCardRule = pgTable(
  'LinkCardRule',
  {
    id: serial().primaryKey().notNull(),
    hostname: varchar({ length: 255 }).notNull(),
    note: varchar({ length: 100 }),
    imageSelection: varchar({ length: 5 })
      .$type<'first' | 'last'>()
      .default('first')
      .notNull(),
    descriptionSelection: varchar({ length: 5 })
      .$type<'first' | 'last'>()
      .default('first')
      .notNull(),
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
    check(
      'LinkCardRule_imageSelection_check',
      sql`${table.imageSelection} IN ('first', 'last')`,
    ),
    check(
      'LinkCardRule_descriptionSelection_check',
      sql`${table.descriptionSelection} IN ('first', 'last')`,
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
    index('Message_threadId_id_idx').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.id.asc().nullsLast().op('int8_ops'),
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

/** Lightweight persistent discovery entry. Message bodies remain in Message and are pulled through
 * the thread endpoint; this row only makes their existence durable across restart/SSE loss. */
export const discoveryChange = pgTable(
  'DiscoveryChange',
  {
    targetId: bigint({ mode: 'bigint' }).notNull(),
    changeId: bigint({ mode: 'bigint' }).notNull(),
    /** Audience that admitted the change. It becomes null when current access is revoked; the change
     * itself remains durable historical proof that this target had already received the message. */
    audienceId: bigint({ mode: 'bigint' }),
    threadId: integer().notNull(),
    messageId: bigint({ mode: 'bigint' }).notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.targetId, table.changeId],
      name: 'DiscoveryChange_pkey',
    }),
    uniqueIndex('DiscoveryChange_target_message_key').on(
      table.targetId,
      table.messageId,
    ),
    index('DiscoveryChange_audience_idx').on(table.audienceId),
    foreignKey({
      columns: [table.targetId],
      foreignColumns: [discoveryTarget.id],
      name: 'DiscoveryChange_targetId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.audienceId],
      foreignColumns: [threadAudience.id],
      name: 'DiscoveryChange_audienceId_fkey',
    }).onDelete('set null'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'DiscoveryChange_threadId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.messageId],
      foreignColumns: [message.id],
      name: 'DiscoveryChange_messageId_fkey',
    }).onDelete('cascade'),
    check('DiscoveryChange_changeId_check', sql`${table.changeId} > 0`),
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

/** One user's moderation request for one durable Message row. Message content is deliberately not
 * copied: Message rows are soft-deleted, so the authoritative evidence remains readable to admins. */
export const messageReport = pgTable(
  'MessageReport',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    messageId: bigint({ mode: 'bigint' }).notNull(),
    threadId: integer().notNull(),
    messageSeq: integer().notNull(),
    reporterId: integer().notNull(),
    status: messageReportStatus().default('PENDING').notNull(),
    reviewedByAdminId: integer(),
    reviewedAt: timestamp({ precision: 3, mode: 'date' }),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('MessageReport_reporterId_messageId_key').using(
      'btree',
      table.reporterId.asc().nullsLast().op('int4_ops'),
      table.messageId.asc().nullsLast().op('int8_ops'),
    ),
    index('MessageReport_status_createdAt_idx').using(
      'btree',
      table.status.asc().nullsLast().op('enum_ops'),
      table.createdAt.desc().nullsLast().op('timestamp_ops'),
    ),
    index('MessageReport_messageId_idx').using(
      'btree',
      table.messageId.asc().nullsLast().op('int8_ops'),
    ),
    foreignKey({
      columns: [table.messageId],
      foreignColumns: [message.id],
      name: 'MessageReport_messageId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'MessageReport_threadId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      columns: [table.reporterId],
      foreignColumns: [user.id],
      name: 'MessageReport_reporterId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('restrict'),
    foreignKey({
      columns: [table.reviewedByAdminId],
      foreignColumns: [admin.id],
      name: 'MessageReport_reviewedByAdminId_fkey',
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
    // Download-inbox extension (federation design doc §12.2): groups a message's files by batchId and
    // tracks per-file state in FileSyncProgress. direction distinguishes outbound staging from inbound
    // localization; originDomain/expectedFederationVersion are inbound-only.
    direction: fileSyncDirection().default('OUTBOUND').notNull(),
    batchId: uuid().defaultRandom().notNull(),
    fileCnt: integer().default(1).notNull(),
    anyFailed: boolean().default(false).notNull(),
    originDomain: varchar({ length: 63 }),
    expectedFederationVersion: integer(),
  },
  (table) => [
    index('PendingMedia_batchId_idx').on(table.batchId),
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
      foreignColumns: [user.id],
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
    bytesTotal: bigint({ mode: 'bigint' }).default(0n).notNull(),
    bytesReceived: bigint({ mode: 'bigint' }).default(0n).notNull(),
    originDomain: varchar({ length: 63 }),
    errorKind: varchar({ length: 255 }),
    // Tick-once guard: once this file's file-cnt/file-bytes quota has been charged, admin retry or crash-resume
    // must not re-charge it. Set true after the first successful claim.
    quotaCounted: boolean().default(false).notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
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

/** Profile entries sharing User.threadRevision's state cursor with thread ADD/DELETE entries. */
export const profileStateRevision = pgTable(
  'ProfileStateRevision',
  {
    userId: integer().notNull(),
    subjectUserId: integer().notNull(),
    revision: integer().notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.subjectUserId],
      name: 'ProfileStateRevision_pkey',
    }),
    index('ProfileStateRevision_userId_revision_idx').on(
      table.userId,
      table.revision,
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'ProfileStateRevision_userId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.subjectUserId],
      foreignColumns: [user.id],
      name: 'ProfileStateRevision_subjectUserId_fkey',
    }).onDelete('cascade'),
    check('ProfileStateRevision_revision_check', sql`${table.revision} > 0`),
  ],
);

export const systemSetting = pgTable('SystemSetting', {
  key: varchar({ length: 63 }).primaryKey().notNull(),
  value: text().notNull(),
  updatedAt: timestamp({ precision: 3, mode: 'date' }).notNull(),
});

/** Non-secret anchor for this installation's immutable federation identity. The private root key stays
 * on disk; this row detects a missing/replaced key file and a changed SOMS_DOMAIN before S2S resumes. */
export const localFederationIdentity = pgTable('LocalFederationIdentity', {
  domain: varchar({ length: 63 }).primaryKey().notNull(),
  rootKeyFingerprint: varchar({ length: 80 }).notNull(),
  createdAt: timestamp({ precision: 3, mode: 'date' })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export const federatedPeer = pgTable(
  'FederatedPeer',
  {
    domain: varchar({ length: 63 }).primaryKey().notNull(),
    trustLevel: varchar({ length: 31 }).default('pending').notNull(),
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
    dailyRequestLimit: integer(),
    // Quota circuit-breaker file dimensions (daily). All file types (image/video/audio/file) consolidate into a
    // single file cnt + file total size; bundles count +1 file cnt and 0 bytes. null = use the global default.
    dailyFileLimit: integer(),
    dailyFileBytesLimit: bigint({ mode: 'bigint' }),
    pairwiseServerId: varchar({ length: 64 }),
    rootKeyFingerprint: varchar({ length: 80 }),
    identityPinnedAt: timestamp({ precision: 3, mode: 'date' }),
    identityLostAt: timestamp({ precision: 3, mode: 'date' }),
    identityLostReason: varchar({ length: 255 }),
    resetGeneration: integer().default(0).notNull(),
    resetAt: timestamp({ precision: 3, mode: 'date' }),
  },
  (table) => [
    check(
      'FederatedPeer_trustLevel_check',
      sql`${table.trustLevel} IN ('pending', 'trusted', 'demoted', 'blocked', 'identity_lost', 'reset_in_progress')`,
    ),
    index('FederatedPeer_lastSuccessAt_idx').using(
      'btree',
      table.lastSuccessAt.asc().nullsLast().op('timestamp_ops'),
    ),
    index('FederatedPeer_trustLevel_idx').using(
      'btree',
      table.trustLevel.asc().nullsLast().op('text_ops'),
    ),
    uniqueIndex('FederatedPeer_single_reset_in_progress_key')
      .on(sql`(true)`)
      .where(sql`${table.trustLevel} = 'reset_in_progress'`),
  ],
);

/** Per-peer compacted state feed. A key is overwritten only by a newer business revision; rev
 * gaps are therefore expected and consumers advance using scannedThrough, never the last item. */
export const peerStateFeed = pgTable(
  'PeerStateFeed',
  {
    peerDomain: varchar({ length: 63 }).notNull(),
    account: varchar({ length: 31 }).notNull(),
    eventType: peerStateEventType().notNull(),
    subjectAccount: varchar({ length: 31 }).default('').notNull(),
    revision: integer().notNull(),
    rev: bigint({ mode: 'bigint' }).notNull(),
    body: jsonb().notNull(),
    createdAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.peerDomain,
        table.account,
        table.eventType,
        table.subjectAccount,
      ],
      name: 'PeerStateFeed_pkey',
    }),
    uniqueIndex('PeerStateFeed_peerDomain_rev_key').on(
      table.peerDomain,
      table.rev,
    ),
    foreignKey({
      columns: [table.peerDomain],
      foreignColumns: [federatedPeer.domain],
      name: 'PeerStateFeed_peerDomain_fkey',
    }).onDelete('cascade'),
    check('PeerStateFeed_revision_check', sql`${table.revision} >= 0`),
    check('PeerStateFeed_rev_check', sql`${table.rev} > 0`),
    check(
      'PeerStateFeed_subject_check',
      sql`(${table.eventType} = 'P2P_META' AND ${table.subjectAccount} <> '') OR (${table.eventType} <> 'P2P_META' AND ${table.subjectAccount} = '')`,
    ),
  ],
);

export const peerStateFeedTarget = pgTable(
  'PeerStateFeedTarget',
  {
    peerDomain: varchar({ length: 63 }).primaryKey().notNull(),
    allocatedThrough: bigint({ mode: 'bigint' }).default(0n).notNull(),
    startRev: bigint({ mode: 'bigint' }).default(0n).notNull(),
    acknowledgedThrough: bigint({ mode: 'bigint' }).default(0n).notNull(),
    lastServedThrough: bigint({ mode: 'bigint' }).default(0n).notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.peerDomain],
      foreignColumns: [federatedPeer.domain],
      name: 'PeerStateFeedTarget_peerDomain_fkey',
    }).onDelete('cascade'),
    check(
      'PeerStateFeedTarget_allocatedThrough_check',
      sql`${table.allocatedThrough} >= 0`,
    ),
    check(
      'PeerStateFeedTarget_cursor_check',
      sql`${table.startRev} >= 0 AND ${table.acknowledgedThrough} >= ${table.startRev} AND ${table.lastServedThrough} >= ${table.acknowledgedThrough} AND ${table.allocatedThrough} >= ${table.lastServedThrough}`,
    ),
  ],
);

export const peerStateFeedPullCursor = pgTable(
  'PeerStateFeedPullCursor',
  {
    peerDomain: varchar({ length: 63 }).primaryKey().notNull(),
    remoteHwm: bigint({ mode: 'bigint' }).default(0n).notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.peerDomain],
      foreignColumns: [federatedPeer.domain],
      name: 'PeerStateFeedPullCursor_peerDomain_fkey',
    }).onDelete('cascade'),
    check(
      'PeerStateFeedPullCursor_remoteHwm_check',
      sql`${table.remoteHwm} >= 0`,
    ),
  ],
);

/** One authoritative directed request. A and B may each retain an independent row and note. */
export const friendRequest = pgTable(
  'FriendRequest',
  {
    id: bigserial({ mode: 'bigint' }).notNull(),
    requesterUserId: integer().notNull(),
    targetUserId: integer().notNull(),
    status: friendRequestStatus().notNull(),
    note: varchar({ length: 255 }).default('').notNull(),
    revision: integer().default(0).notNull(),
    requestedAt: timestamp({ precision: 3, mode: 'date' }),
    expiresAt: timestamp({ precision: 3, mode: 'date' }),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('FriendRequest_id_key').on(table.id),
    primaryKey({
      columns: [table.requesterUserId, table.targetUserId],
      name: 'FriendRequest_pkey',
    }),
    foreignKey({
      columns: [table.requesterUserId],
      foreignColumns: [user.id],
      name: 'FriendRequest_requesterUserId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.targetUserId],
      foreignColumns: [user.id],
      name: 'FriendRequest_targetUserId_fkey',
    }).onDelete('cascade'),
    check(
      'FriendRequest_revision_check',
      sql`${table.revision} >= 0 AND ${table.requesterUserId} <> ${table.targetUserId}`,
    ),
  ],
);

/** Canonical unordered pair row. Every relationship transaction locks this row before touching either
 * directed request, preventing crossed inserts from both missing one another. */
export const friendPair = pgTable(
  'FriendPair',
  {
    userLowId: integer().notNull(),
    userHighId: integer().notNull(),
    threadId: integer(),
    active: boolean().default(false).notNull(),
    revision: integer().default(0).notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userLowId, table.userHighId],
      name: 'FriendPair_pkey',
    }),
    foreignKey({
      columns: [table.userLowId],
      foreignColumns: [user.id],
      name: 'FriendPair_userLowId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.userHighId],
      foreignColumns: [user.id],
      name: 'FriendPair_userHighId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'FriendPair_threadId_fkey',
    }).onDelete('set null'),
    check(
      'FriendPair_order_check',
      sql`${table.userLowId} < ${table.userHighId}`,
    ),
    check('FriendPair_revision_check', sql`${table.revision} >= 0`),
  ],
);

export const groupMembershipRequest = pgTable(
  'GroupMembershipRequest',
  {
    id: bigserial({ mode: 'bigint' }).notNull(),
    groupUserId: integer().notNull(),
    memberUserId: integer().notNull(),
    direction: groupMembershipDirection().notNull(),
    status: groupMembershipRequestStatus().notNull(),
    note: varchar({ length: 255 }).default('').notNull(),
    revision: integer().default(0).notNull(),
    requestedAt: timestamp({ precision: 3, mode: 'date' }),
    expiresAt: timestamp({ precision: 3, mode: 'date' }),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('GroupMembershipRequest_id_key').on(table.id),
    primaryKey({
      columns: [table.groupUserId, table.memberUserId, table.direction],
      name: 'GroupMembershipRequest_pkey',
    }),
    foreignKey({
      columns: [table.groupUserId],
      foreignColumns: [user.id],
      name: 'GroupMembershipRequest_groupUserId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.memberUserId],
      foreignColumns: [user.id],
      name: 'GroupMembershipRequest_memberUserId_fkey',
    }).onDelete('cascade'),
    check(
      'GroupMembershipRequest_revision_check',
      sql`${table.revision} >= 0 AND ${table.groupUserId} <> ${table.memberUserId}`,
    ),
  ],
);

export const groupMembershipPair = pgTable(
  'GroupMembershipPair',
  {
    groupUserId: integer().notNull(),
    memberUserId: integer().notNull(),
    active: boolean().default(false).notNull(),
    role: groupRole().default('MEMBER').notNull(),
    revision: integer().default(0).notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.groupUserId, table.memberUserId],
      name: 'GroupMembershipPair_pkey',
    }),
    foreignKey({
      columns: [table.groupUserId],
      foreignColumns: [user.id],
      name: 'GroupMembershipPair_groupUserId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.memberUserId],
      foreignColumns: [user.id],
      name: 'GroupMembershipPair_memberUserId_fkey',
    }).onDelete('cascade'),
    check('GroupMembershipPair_revision_check', sql`${table.revision} >= 0`),
  ],
);

/** Receiver-side cursor for one remote server's durable discovery feed. remoteHwm advances only after
 * a missed page is fully applied in a local transaction; wake-up HWM hints remain process-local. */
export const federationPullCursor = pgTable(
  'FederationPullCursor',
  {
    peerDomain: varchar({ length: 63 }).primaryKey().notNull(),
    /** Immutable floor received during the current peer identity's first trusted handshake. */
    startChangeId: bigint({ mode: 'bigint' }).default(0n).notNull(),
    remoteHwm: bigint({ mode: 'bigint' }).default(0n).notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.peerDomain],
      foreignColumns: [federatedPeer.domain],
      name: 'FederationPullCursor_peerDomain_fkey',
    }).onDelete('cascade'),
    check(
      'FederationPullCursor_remoteHwm_check',
      sql`${table.remoteHwm} >= ${table.startChangeId}`,
    ),
    check(
      'FederationPullCursor_startChangeId_check',
      sql`${table.startChangeId} >= 0`,
    ),
  ],
);

/** Source-side missed protocol state. startChangeId is the immutable pre-trust history floor.
 * acknowledgedThrough never moves backwards; lastServedThrough records the latest scanned page.
 * A NOWAIT row lock rejects overlapping requests from the same peer without blocking. */
export const federationServeCursor = pgTable(
  'FederationServeCursor',
  {
    peerDomain: varchar({ length: 63 }).primaryKey().notNull(),
    targetId: bigint({ mode: 'bigint' }).notNull(),
    startChangeId: bigint({ mode: 'bigint' }).notNull(),
    acknowledgedThrough: bigint({ mode: 'bigint' }).notNull(),
    lastServedThrough: bigint({ mode: 'bigint' }).notNull(),
    updatedAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('FederationServeCursor_targetId_key').on(table.targetId),
    foreignKey({
      columns: [table.peerDomain],
      foreignColumns: [federatedPeer.domain],
      name: 'FederationServeCursor_peerDomain_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.targetId],
      foreignColumns: [discoveryTarget.id],
      name: 'FederationServeCursor_targetId_fkey',
    }).onDelete('cascade'),
    check(
      'FederationServeCursor_startChangeId_check',
      sql`${table.startChangeId} >= 0`,
    ),
    check(
      'FederationServeCursor_acknowledgedThrough_check',
      sql`${table.acknowledgedThrough} >= ${table.startChangeId}`,
    ),
    check(
      'FederationServeCursor_lastServedThrough_check',
      sql`${table.lastServedThrough} >= ${table.acknowledgedThrough}`,
    ),
  ],
);

/** Survives destructive peer reset after FederatedPeer itself is removed. It prevents a newly
 * registered server at the same domain from inheriting trust merely by completing /init. */
export const federatedPeerReset = pgTable(
  'FederatedPeerReset',
  {
    domain: varchar({ length: 63 }).primaryKey().notNull(),
    resetGeneration: integer().notNull(),
    reinitPending: boolean().default(false).notNull(),
    resetAt: timestamp({ precision: 3, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    check(
      'FederatedPeerReset_resetGeneration_check',
      sql`${table.resetGeneration} > 0`,
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
    dailyRequestLimit: integer(),
    // Quota circuit-breaker file dimensions (daily). All file types consolidate into a single file cnt + file
    // total size; bundles count +1 file cnt and 0 bytes. null = use the global default.
    dailyFileLimit: integer(),
    dailyFileBytesLimit: bigint({ mode: 'bigint' }),
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

/**
 * Daily file-total-size accumulator for a federated peer (bigint — count tables above are integer). One row per
 * (domain, UTC day). The file-cnt dimension reuses QuotaDailyUsage with category 'files'; the byte dimension lives
 * here because byte totals exceed integer range. Drives the per-peer circuit breaker. See src/quota/quota.service.ts.
 */
export const quotaFileByteUsage = pgTable(
  'QuotaFileByteUsage',
  {
    domain: varchar({ length: 63 }).notNull(),
    date: date({ mode: 'date' }).notNull(),
    bytes: bigint({ mode: 'bigint' }).default(0n).notNull(),
  },
  (table) => [
    index('QuotaFileByteUsage_date_idx').using(
      'btree',
      table.date.asc().nullsLast().op('date_ops'),
    ),
    primaryKey({
      columns: [table.domain, table.date],
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
    bytes: bigint({ mode: 'bigint' }).default(0n).notNull(),
  },
  (table) => [
    index('UserQuotaFileByteUsage_date_idx').using(
      'btree',
      table.date.asc().nullsLast().op('date_ops'),
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'UserQuotaFileByteUsage_userId_fkey',
    }).onDelete('cascade'),
    primaryKey({
      columns: [table.userId, table.date],
      name: 'UserQuotaFileByteUsage_pkey',
    }),
  ],
);

/**
 * Admin "continue / add quota": a per-(domain, UTC-day) ADDITIVE allowance on top of the base limit. The
 * effective breaker limit for today = base (override ?? default) + extra*. Persisted (survives restart);
 * auto-resets via the date key. See QuotaService.addQuota.
 */
export const quotaDailyAllowance = pgTable(
  'QuotaDailyAllowance',
  {
    domain: varchar({ length: 63 }).notNull(),
    date: date({ mode: 'date' }).notNull(),
    extraMsg: integer().default(0).notNull(),
    extraFile: integer().default(0).notNull(),
    extraFileBytes: bigint({ mode: 'bigint' }).default(0n).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.domain, table.date],
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
    extraFileBytes: bigint({ mode: 'bigint' }).default(0n).notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
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
