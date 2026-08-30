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
  'IMAGE',
  'VIDEO',
  'FILE',
  'AUDIO',
  'LINK',
  'CONTACT_CARD',
  'CALL',
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
export const pushPlatform = pgEnum('PushPlatform', ['ANDROID', 'WEB', 'IOS']);
export const uploadSessionStatus = pgEnum('UploadSessionStatus', [
  'UPLOADING',
  'COMPLETING',
  'COMPLETED',
  'ABORTED',
]);
export const peerStateEventType = pgEnum('PeerStateEventType', [
  'PROFILE',
  'RELATIONSHIP_INTENT',
  'GROUP_META_FEED_HEAD',
  'THREAD_CONTENT_HEAD',
]);
export const groupMetaMemberOperation = pgEnum('GroupMetaMemberOperation', [
  'UPSERT',
  'DEPART',
]);
export const relationshipIntentStatus = pgEnum('RelationshipIntentStatus', [
  'REQUESTED',
  'ACCEPTED',
  'REVOKED',
]);

export const messageDeleteType = pgEnum('MessageDeleteType', [
  'USER_RETRACTION',
  'MODERATION_REMOVAL',
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
    rootKeyFingerprint: varchar({ length: 80 }),
    rootPublicKey: varchar({ length: 44 }),
    identityPinnedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    retiredAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('IdentityNamespace_domain_id_key').on(table.domain, table.id),
    uniqueIndex('IdentityNamespace_one_live_per_domain_key')
      .on(table.domain)
      .where(sql`${table.id} > 0 AND ${table.retiredAt} IS NULL`),
    check(
      'IdentityNamespace_shape_check',
      sql`(
        ${table.id} = 0
        AND ${table.domain} = 'local'
        AND ${table.rootKeyFingerprint} IS NULL
        AND ${table.rootPublicKey} IS NULL
        AND ${table.identityPinnedAt} IS NULL
        AND ${table.retiredAt} IS NULL
      ) OR (
        ${table.id} > 0
        AND ${table.domain} <> 'local'
        AND ${table.rootKeyFingerprint} IS NOT NULL
        AND ${table.rootPublicKey} IS NOT NULL
        AND ${table.identityPinnedAt} IS NOT NULL
      )`,
    ),
    check(
      'IdentityNamespace_retiredAt_check',
      sql`${table.retiredAt} IS NULL OR ${table.retiredAt} >= ${table.createdAt}`,
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
    sourceNamespaceId: integer(),
    sourceBundleId: varchar({ length: 26 }),
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
    uniqueIndex('ForwardBundle_sourceNamespace_sourceBundleId_key').using(
      'btree',
      table.sourceNamespaceId.asc().nullsLast().op('int4_ops'),
      table.sourceBundleId.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.sourceNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'ForwardBundle_sourceNamespaceId_fkey',
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

export const user = pgTable(
  'User',
  {
    id: serial().primaryKey().notNull(),
    account: varchar({ length: 31 }).notNull(),
    name: text().notNull(),
    avatar: text().default('').notNull(),
    bio: varchar({ length: 255 }).default('').notNull(),
    domain: varchar({ length: 63 }).default('local').notNull(),
    /** Publisher of this source-scoped profile. Only identities created here use `local`. */
    sourceDomain: varchar({ length: 63 }).default('local').notNull(),
    /** Identity namespace which materialized this projection; 0 for locally created identities. */
    namespaceId: integer().default(0).notNull(),
    availability: varchar({ length: 16 }).default('AVAILABLE').notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    profileRev: integer().default(0).notNull(),
  },
  (table) => [
    unique('User_account_domain_sourceDomain_namespaceId_key').on(
      table.account,
      table.domain,
      table.sourceDomain,
      table.namespaceId,
    ),
    index('User_address_idx').on(table.account, table.domain),
    index('User_source_address_idx').on(
      table.sourceDomain,
      table.namespaceId,
      table.account,
      table.domain,
    ),
    foreignKey({
      columns: [table.sourceDomain, table.namespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'User_sourceNamespace_fkey',
    }).onDelete('restrict'),
    check(
      'User_namespace_check',
      sql`(${table.sourceDomain} = 'local') = (${table.namespaceId} = 0)`,
    ),
    check('User_account_check', sql`${table.account} NOT LIKE '!%'`),
    check(
      'User_availability_check',
      sql`${table.availability} IN ('AVAILABLE', 'REMOVED')`,
    ),
  ],
);

/** Local authentication/control-plane account. Federated identities never receive one. */
export const account = pgTable(
  'Account',
  {
    /** Shared primary key with the locally-created User identity. */
    id: integer().primaryKey().notNull(),
    hashPwd: varchar({ length: 127 }),
    mustChangePassword: boolean().default(false).notNull(),
    disabledAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    stateFeedAllocatedThrough: integer().default(0).notNull(),
    readRevision: integer().default(0).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.id],
      foreignColumns: [user.id],
      name: 'Account_id_fkey',
    }).onDelete('cascade'),
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

/** Source-correct roster membership for every conversation. P2P threads have exactly two rows;
 * group rows retain departures so historical messages keep a resolvable author. */
export const threadMember = pgTable(
  'ThreadMember',
  {
    id: serial().primaryKey().notNull(),
    threadId: integer().notNull(),
    userId: integer().notNull(),
    role: groupRole(),
    left: boolean().default(false).notNull(),
    /** Earliest authored sequence tracked by a group hosted on this server. */
    firstSentSeq: integer(),
    /** Latest authored sequence tracked by a locally hosted group. */
    lastSentSeq: integer(),
    joinedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
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
    uniqueIndex('ThreadMember_threadId_userId_key').on(
      table.threadId,
      table.userId,
    ),
    uniqueIndex('ThreadMember_id_threadId_key').on(table.id, table.threadId),
    index('ThreadMember_threadId_left_lastSentSeq_idx').on(
      table.threadId,
      table.left,
      table.lastSentSeq,
    ),
    index('ThreadMember_threadId_left_firstSentSeq_idx').on(
      table.threadId,
      table.left,
      table.firstSentSeq,
    ),
    uniqueIndex('ThreadMember_one_current_owner_key')
      .on(table.threadId)
      .where(sql`${table.role} = 'OWNER' AND ${table.left} = false`),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'ThreadMember_threadId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [user.id],
      name: 'ThreadMember_userId_fkey',
    }).onDelete('restrict'),
    check(
      'ThreadMember_lastSentSeq_check',
      sql`${table.lastSentSeq} IS NULL OR ${table.lastSentSeq} > 0`,
    ),
    check(
      'ThreadMember_firstSentSeq_check',
      sql`${table.firstSentSeq} IS NULL OR ${table.firstSentSeq} > 0`,
    ),
  ],
);

export const threadParticipant = pgTable(
  'ThreadParticipant',
  {
    id: serial().primaryKey().notNull(),
    /** Local account that owns this conversation state. */
    accountId: integer().notNull(),
    threadId: integer().notNull(),
    /** Local role fact. Null for P2P conversations. */
    role: groupRole(),
    lastReadSeq: integer(),
    readRevision: integer().default(0).notNull(),
    muted: boolean().default(false).notNull(),
    /** Suppress this conversation's live delivery/catch-up for this participant. History stays stored. */
    blocked: boolean().default(false).notNull(),
    pinned: boolean().default(false).notNull(),
    pinnedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    clearedSeq: integer(),
    messageVisibleBeforeSeq: bigint({ mode: 'number' }),
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
    uniqueIndex('ThreadParticipant_accountId_threadId_key').on(
      table.accountId,
      table.threadId,
    ),
    index('ThreadParticipant_threadId_idx').on(table.threadId),
    index('ThreadParticipant_accountId_pinned_idx').on(
      table.accountId,
      table.pinned,
    ),
    index('ThreadParticipant_accountId_readRevision_idx').on(
      table.accountId,
      table.readRevision,
    ),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [account.id],
      name: 'ThreadParticipant_accountId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'ThreadParticipant_threadId_fkey',
    }).onDelete('restrict'),
    check(
      'ThreadParticipant_cleared_seq_check',
      sql`${table.clearedSeq} IS NULL OR ${table.clearedSeq} >= 0`,
    ),
    check(
      'ThreadParticipant_messageVisibleBeforeSeq_check',
      sql`${table.messageVisibleBeforeSeq} IS NULL OR ${table.messageVisibleBeforeSeq} > 1`,
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
    deletionSeqAllocatedThrough: integer().default(0).notNull(),
    lastMessageSeq: integer(),
    lastMessagePreview: varchar({ length: 255 }),
    lastMessageAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    groupId: integer(),
    pullUntil: integer().default(0).notNull(),
    /** Identity namespace which owns this thread coordinate space. */
    authorityNamespaceId: integer().default(0).notNull(),
    /** Invalidates a response when the retained thread coordinate space itself is replaced. */
    federationVersion: integer().default(0).notNull(),
    /** Invalidates federation work captured before an effective authorization transition. */
    authorizationEpoch: integer().default(0).notNull(),
  },
  (table) => [
    uniqueIndex('MessageThread_groupId_key').using(
      'btree',
      table.groupId.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [group.id],
      name: 'MessageThread_groupId_fkey',
    })
      .onUpdate('cascade')
      .onDelete('cascade'),
    check(
      'MessageThread_groupId_type_check',
      sql`(type = 'P2P'::"MessageThreadType") = ("groupId" IS NULL)`,
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
      'MessageThread_deletionSeqAllocatedThrough_check',
      sql`${table.deletionSeqAllocatedThrough} >= 0`,
    ),
  ],
);

/** Current thread access for a local user or a federated peer. */
export const threadAudience = pgTable(
  'ThreadAudience',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    /** `local` addresses one local user; every other value addresses the whole federated peer domain. */
    targetDomain: varchar({ length: 63 }).notNull(),
    targetNamespaceId: integer().default(0).notNull(),
    localUserId: integer(),
    threadId: integer().notNull(),
    /** Exclusive federation message-access lower bound. A peer audience may query only messages with
     *  a greater thread sequence. It advances when a closed relationship is reauthorized. */
    messageAccessAfterSeq: integer().default(0).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
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
      .where(sql`${table.targetDomain} = 'local'`),
    uniqueIndex('ThreadAudience_peer_key')
      .using(
        'btree',
        table.targetNamespaceId.asc().nullsLast().op('int4_ops'),
        table.threadId.asc().nullsLast().op('int4_ops'),
      )
      .where(sql`${table.targetDomain} <> 'local'`),
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
        table.targetNamespaceId.asc().nullsLast().op('int4_ops'),
        table.threadId.asc().nullsLast().op('int4_ops'),
      )
      .where(sql`${table.targetDomain} <> 'local'`),
    foreignKey({
      columns: [table.targetDomain, table.targetNamespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
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
      sql`(${table.targetDomain} = 'local' AND ${table.localUserId} IS NOT NULL AND ${table.targetNamespaceId} = 0) OR (${table.targetDomain} <> 'local' AND ${table.localUserId} IS NULL AND ${table.targetNamespaceId} > 0)`,
    ),
    check(
      'ThreadAudience_messageAccessAfterSeq_check',
      sql`${table.messageAccessAfterSeq} >= 0`,
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
    contentType: contentType().notNull(),
    content: jsonbText().notNull(),
    threadId: integer().notNull(),
    /** Author identity snapshot. Both fields are null only for server-authored SYSTEM notices. */
    creatorAccount: varchar({ length: 31 }),
    creatorDomain: varchar({ length: 63 }),
    creatorNamespaceId: integer().default(0).notNull(),
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
    /** Direct publisher whose thread-local seq is stored in originSeq. Null for local originals. */
    federationSourceDomain: varchar({ length: 255 }),
    sourceNamespaceId: integer(),
    /** Local materialization state. STUB and FAILED are client-visible placeholders; only READY
     * participates in durable message-derived projections and federation publication. */
    localState: messageLocalState().default('READY').notNull(),
  },
  (table) => [
    check('Message_seq_check', sql`${table.seq} > 0`),
    check(
      'Message_system_creator_check',
      sql`(${table.contentType} = 'SYSTEM' AND ${table.creatorAccount} IS NULL AND ${table.creatorDomain} IS NULL) OR (${table.contentType} <> 'SYSTEM' AND ${table.creatorAccount} IS NOT NULL AND ${table.creatorDomain} IS NOT NULL)`,
    ),
    check(
      'Message_origin_seq_check',
      sql`${table.originSeq} IS NULL OR ${table.originSeq} > 0`,
    ),
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
      table.creatorDomain.asc().nullsLast().op('text_ops'),
      table.creatorNamespaceId.asc().nullsLast().op('int4_ops'),
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
    uniqueIndex('Message_threadId_creator_originSeq_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.creatorAccount.asc().nullsLast().op('text_ops'),
      table.creatorDomain.asc().nullsLast().op('text_ops'),
      table.creatorNamespaceId.asc().nullsLast().op('int4_ops'),
      table.originSeq.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('Message_threadId_source_originSeq_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.sourceNamespaceId.asc().nullsLast().op('int4_ops'),
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
    foreignKey({
      columns: [table.creatorNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'Message_creatorNamespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.federationSourceDomain, table.sourceNamespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'Message_identityNamespace_fkey',
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

/** A peer's processing-receipt coordinate for one existing local message. Receipt copies are not
 * inserted into the timeline, but later quotes may address their peer-assigned sequence. */
export const federationMessageReceipt = pgTable(
  'FederationMessageReceipt',
  {
    peerDomain: varchar({ length: 63 }).notNull(),
    namespaceId: integer().notNull(),
    threadId: integer().notNull(),
    peerSeq: integer().notNull(),
    messageId: bigint({ mode: 'bigint' }).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.namespaceId, table.threadId, table.peerSeq],
      name: 'FederationMessageReceipt_pkey',
    }),
    check('FederationMessageReceipt_peerSeq_check', sql`${table.peerSeq} > 0`),
    index('FederationMessageReceipt_messageId_idx').on(table.messageId),
    foreignKey({
      columns: [table.peerDomain, table.namespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'FederationMessageReceipt_namespace_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'FederationMessageReceipt_threadId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.messageId],
      foreignColumns: [message.id],
      name: 'FederationMessageReceipt_messageId_fkey',
    }).onDelete('cascade'),
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
    /** Non-null only when this local projection consumed a remote authority fact. Such a row must
     * never be published again; group-origin acceptance of a member submission remains null. */
    federationSourceDomain: varchar({ length: 63 }),
    sourceNamespaceId: integer(),
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
      columns: [table.sourceNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'DeletedMessage_sourceNamespaceId_fkey',
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
 * the stable publisher coordinate (thread, sourceDomain, messageSeq). */
export const federatedMessageTombstone = pgTable(
  'FederatedMessageTombstone',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    threadId: integer().notNull(),
    messageSeq: integer().notNull(),
    authorityDomain: varchar({ length: 255 }).notNull(),
    sourceDomain: varchar({ length: 255 }).notNull(),
    sourceNamespaceId: integer().notNull(),
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
      table.sourceNamespaceId.asc().nullsLast().op('int4_ops'),
      table.messageSeq.asc().nullsLast().op('int4_ops'),
    ),
    uniqueIndex('FederatedMessageTombstone_source_event_key').using(
      'btree',
      table.sourceNamespaceId.asc().nullsLast().op('int4_ops'),
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.remoteDeletionSeq.asc().nullsLast().op('int4_ops'),
    ),
    foreignKey({
      columns: [table.sourceNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'FederatedMessageTombstone_sourceNamespaceId_fkey',
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

/** One cursor per ordered remote deletion stream. A thread can have several streams (notably a group
 * origin pulling author servers), hence this is not a MessageThread column. */
export const federationDeletedCursor = pgTable(
  'FederationDeletedCursor',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    threadId: integer().notNull(),
    peerDomain: varchar({ length: 255 }).notNull(),
    namespaceId: integer().notNull(),
    streamAccount: varchar({ length: 255 }).default('').notNull(),
    streamKind: varchar({ length: 32 }).notNull(),
    committedThrough: integer().default(0).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    check(
      'FederationDeletedCursor_committedThrough_check',
      sql`${table.committedThrough} >= 0`,
    ),
    uniqueIndex('FederationDeletedCursor_stream_key').using(
      'btree',
      table.threadId.asc().nullsLast().op('int4_ops'),
      table.namespaceId.asc().nullsLast().op('int4_ops'),
      table.streamAccount.asc().nullsLast().op('text_ops'),
      table.streamKind.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'FederationDeletedCursor_namespaceId_fkey',
    }).onDelete('restrict'),
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
    reviewedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
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
      table.createdAt.desc().nullsLast().op('timestamptz_ops'),
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
      foreignColumns: [account.id],
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
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    index('FederatedPeerEvent_createdAt_idx').using(
      'btree',
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('FederatedPeerEvent_domain_createdAt_idx').using(
      'btree',
      table.domain.asc().nullsLast().op('text_ops'),
      table.createdAt.asc().nullsLast().op('timestamptz_ops'),
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
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    lastSeenAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
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
      foreignColumns: [account.id],
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
    creatorDomain: varchar({ length: 63 }),
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
    namespaceId: integer().default(0).notNull(),
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
          AND ${table.creatorDomain} IS NOT NULL
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
          AND ${table.creatorDomain} IS NULL
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
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'PendingMedia_namespaceId_fkey',
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
    receivedBytes: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
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
    bytesTotal: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
    bytesReceived: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
    originDomain: varchar({ length: 63 }),
    namespaceId: integer().default(0).notNull(),
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
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'FileSyncProgress_namespaceId_fkey',
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

export const group = pgTable(
  'Group',
  {
    id: serial().primaryKey().notNull(),
    account: varchar({ length: 31 }).notNull(),
    domain: varchar({ length: 63 }).default('local').notNull(),
    namespaceId: integer().default(0).notNull(),
    name: varchar({ length: 30 }).notNull(),
    avatar: text().default('').notNull(),
    description: varchar({ length: 255 }).default('').notNull(),
    profileRev: integer().default(0).notNull(),
    /** Whether this remote group currently has federation authorization through at least one
     * active local member relationship. Local groups always retain false. */
    federationAuthorized: boolean().default(false).notNull(),
    remoteGroupMetaFeedId: bigint({ mode: 'bigint' }),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    dissolvedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
  },
  (table) => [
    unique('Group_account_domain_namespaceId_key').on(
      table.account,
      table.domain,
      table.namespaceId,
    ),
    foreignKey({
      columns: [table.domain, table.namespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'Group_namespace_fkey',
    }).onDelete('restrict'),
    check(
      'Group_namespace_check',
      sql`(${table.domain} = 'local') = (${table.namespaceId} = 0)`,
    ),
    check('Group_account_sigil_check', sql`${table.account} LIKE '!%'`),
    check('Group_profileRev_check', sql`${table.profileRev} >= 0`),
    check(
      'Group_local_federationAuthorized_check',
      sql`${table.domain} <> 'local' OR ${table.federationAuthorized} = false`,
    ),
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
    subjectDomain: varchar({ length: 63 }).default('local').notNull(),
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

/** Manager-facing request side effects for USER→GROUP applications and GROUP→USER invitations. */
export const groupRequestProjection = pgTable(
  'GroupRequestProjection',
  {
    managerUserId: integer().notNull(),
    threadId: integer().notNull(),
    memberUserId: integer().notNull(),
    direction: varchar({ length: 15 }).notNull(),
    feedId: integer().notNull(),
    requestId: bigint({ mode: 'bigint' }).notNull(),
    status: varchar({ length: 15 }).notNull(),
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
        table.managerUserId,
        table.threadId,
        table.memberUserId,
        table.direction,
      ],
      name: 'GroupRequestProjection_pkey',
    }),
    uniqueIndex('GroupRequestProjection_manager_feed_key').on(
      table.managerUserId,
      table.feedId,
    ),
    index('GroupRequestProjection_thread_feed_idx').on(
      table.managerUserId,
      table.threadId,
      table.feedId,
    ),
    index('GroupRequestProjection_expiry_idx').on(table.expiresAt),
    foreignKey({
      columns: [table.managerUserId],
      foreignColumns: [account.id],
      name: 'GroupRequestProjection_managerUserId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'GroupRequestProjection_threadId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.memberUserId],
      foreignColumns: [user.id],
      name: 'GroupRequestProjection_memberUserId_fkey',
    }).onDelete('cascade'),
    check('GroupRequestProjection_feedId_check', sql`${table.feedId} > 0`),
    check(
      'GroupRequestProjection_direction_check',
      sql`${table.direction} IN ('APPLICATION', 'INVITATION')`,
    ),
    check(
      'GroupRequestProjection_status_check',
      sql`${table.status} IN ('REQUESTED', 'ACCEPTED', 'REVOKED')`,
    ),
    check(
      'GroupRequestProjection_retention_check',
      sql`${table.expiresAt} > ${table.requestedAt} AND ${table.expiresAt} <= ${table.requestedAt} + INTERVAL '7 days'`,
    ),
  ],
);

/** Per-user allocator for the two independent device-facing message feeds. Updating this row is the
 * serialization point for one user's feed coordinates; writers lock users in ascending id order. */
export const clientMessageFeedTarget = pgTable(
  'ClientMessageFeedTarget',
  {
    userId: integer().primaryKey().notNull(),
    messageAllocatedThrough: integer().default(0).notNull(),
    tombstoneAllocatedThrough: integer().default(0).notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'ClientMessageFeedTarget_userId_fkey',
    }).onDelete('cascade'),
    check(
      'ClientMessageFeedTarget_messageAllocatedThrough_check',
      sql`${table.messageAllocatedThrough} >= 0`,
    ),
    check(
      'ClientMessageFeedTarget_tombstoneAllocatedThrough_check',
      sql`${table.tombstoneAllocatedThrough} >= 0`,
    ),
  ],
);

/** Compacted per-user message-discovery projection. messageEndSeq identifies the latest message admitted
 * by the client-feed policy, while visibility, block and read state are still resolved at query time. */
export const clientMessageFeed = pgTable(
  'ClientMessageFeed',
  {
    userId: integer().notNull(),
    threadId: integer().notNull(),
    feedId: integer().notNull(),
    messageEndSeq: integer().notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.threadId],
      name: 'ClientMessageFeed_pkey',
    }),
    uniqueIndex('ClientMessageFeed_user_feedId_key').on(
      table.userId,
      table.feedId,
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'ClientMessageFeed_userId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'ClientMessageFeed_threadId_fkey',
    }).onDelete('cascade'),
    check('ClientMessageFeed_feedId_check', sql`${table.feedId} > 0`),
    check(
      'ClientMessageFeed_messageEndSeq_check',
      sql`${table.messageEndSeq} > 0`,
    ),
  ],
);

/** Compacted per-user deletion-discovery projection. Its coordinate space is intentionally independent
 * from ClientMessageFeed so either stream can be drained and committed without coupling failures. */
export const clientMessageTombstoneFeed = pgTable(
  'ClientMessageTombstoneFeed',
  {
    userId: integer().notNull(),
    threadId: integer().notNull(),
    feedId: integer().notNull(),
    tombstoneEndSeq: integer().notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.threadId],
      name: 'ClientMessageTombstoneFeed_pkey',
    }),
    uniqueIndex('ClientMessageTombstoneFeed_user_feedId_key').on(
      table.userId,
      table.feedId,
    ),
    foreignKey({
      columns: [table.userId],
      foreignColumns: [account.id],
      name: 'ClientMessageTombstoneFeed_userId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'ClientMessageTombstoneFeed_threadId_fkey',
    }).onDelete('cascade'),
    check('ClientMessageTombstoneFeed_feedId_check', sql`${table.feedId} > 0`),
    check(
      'ClientMessageTombstoneFeed_tombstoneEndSeq_check',
      sql`${table.tombstoneEndSeq} > 0`,
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

/** Non-secret anchor for this installation's immutable federation identity. The private root key stays
 * on disk; this row detects a missing/replaced key file and a changed SOMS_DOMAIN before S2S resumes. */
export const localFederationIdentity = pgTable('LocalFederationIdentity', {
  domain: varchar({ length: 63 }).primaryKey().notNull(),
  rootKeyFingerprint: varchar({ length: 80 }).notNull(),
  createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
    .default(sql`CURRENT_TIMESTAMP`)
    .notNull(),
});

export const federatedPeer = pgTable(
  'FederatedPeer',
  {
    domain: varchar({ length: 63 }).primaryKey().notNull(),
    activeNamespaceId: integer(),
    trustLevel: varchar({ length: 31 }).default('unrecognized').notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
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
    dailyMsgLimit: integer(),
    dailyRequestLimit: integer(),
    // Quota circuit-breaker file dimensions (daily). All file types (image/video/audio/file) consolidate into a
    // single file cnt + file total size; bundles count +1 file cnt and 0 bytes. null = use the global default.
    dailyFileLimit: integer(),
    dailyFileBytesLimit: bigint({ mode: 'bigint' }),
    recognizesPeer: boolean().default(false).notNull(),
    outboundRecognitionConfirmed: boolean().default(false).notNull(),
    inboundRecognitionConfirmed: boolean().default(false).notNull(),
    lightweightInboundReady: boolean().default(false).notNull(),
    localServiceAvailable: boolean().default(false).notNull(),
    remoteServiceReachable: boolean().default(false).notNull(),
    reverseRecognitionPending: boolean().default(false).notNull(),
    outboundRecognizedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    inboundRecognizedAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }),
    resetAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check(
      'FederatedPeer_trustLevel_check',
      sql`${table.trustLevel} IN ('unrecognized', 'establishing', 'available', 'degraded', 'halted')`,
    ),
    index('FederatedPeer_lastSuccessAt_idx').using(
      'btree',
      table.lastSuccessAt.asc().nullsLast().op('timestamptz_ops'),
    ),
    index('FederatedPeer_trustLevel_idx').using(
      'btree',
      table.trustLevel.asc().nullsLast().op('text_ops'),
    ),
    foreignKey({
      columns: [table.domain, table.activeNamespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'FederatedPeer_activeNamespace_fkey',
    }).onDelete('restrict'),
  ],
);

/** Per-peer compacted state feed. A changed key receives a new feed ID; gaps are expected and
 * consumers advance using scannedThrough, never the last item. */
export const peerStateFeed = pgTable(
  'PeerStateFeed',
  {
    peerDomain: varchar({ length: 63 }).notNull(),
    namespaceId: integer().notNull(),
    account: varchar({ length: 31 }).notNull(),
    domain: varchar({ length: 63 }).notNull(),
    eventType: peerStateEventType().notNull(),
    subjectAccount: varchar({ length: 31 }).default('').notNull(),
    subjectDomain: varchar({ length: 63 }).default('local').notNull(),
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
        table.domain,
        table.eventType,
        table.subjectAccount,
        table.subjectDomain,
      ],
      name: 'PeerStateFeed_pkey',
    }),
    uniqueIndex('PeerStateFeed_peerDomain_feedId_key').on(
      table.namespaceId,
      table.feedId,
    ),
    foreignKey({
      columns: [table.peerDomain, table.namespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'PeerStateFeed_namespace_fkey',
    }).onDelete('restrict'),
    check('PeerStateFeed_feedId_check', sql`${table.feedId} > 0`),
    check(
      'PeerStateFeed_subject_check',
      sql`(${table.eventType} = 'RELATIONSHIP_INTENT' AND ${table.subjectAccount} <> '' AND ${table.subjectDomain} <> '')
        OR (${table.eventType} = 'THREAD_CONTENT_HEAD' AND ((${table.account} LIKE '!%' AND ${table.subjectAccount} = '' AND ${table.subjectDomain} = 'local') OR (${table.account} NOT LIKE '!%' AND ${table.subjectAccount} <> '' AND ${table.subjectDomain} = ${table.peerDomain})))
        OR (${table.eventType} NOT IN ('RELATIONSHIP_INTENT', 'THREAD_CONTENT_HEAD') AND ${table.subjectAccount} = '' AND ${table.subjectDomain} = 'local')`,
    ),
  ],
);

export const peerStateFeedTarget = pgTable(
  'PeerStateFeedTarget',
  {
    peerDomain: varchar({ length: 63 }).notNull(),
    namespaceId: integer().primaryKey().notNull(),
    allocatedThrough: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.peerDomain, table.namespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'PeerStateFeedTarget_namespace_fkey',
    }).onDelete('restrict'),
    check(
      'PeerStateFeedTarget_allocatedThrough_check',
      sql`${table.allocatedThrough} >= 0`,
    ),
  ],
);

/** Origin-authoritative group roster feed. feedId is the ordered transport and mutation cursor. */
export const groupMetaMemberFeed = pgTable(
  'GroupMetaMemberFeed',
  {
    targetPeerDomain: varchar({ length: 63 }).notNull(),
    targetNamespaceId: integer().notNull(),
    groupId: integer().notNull(),
    feedId: bigint({ mode: 'bigint' }).notNull(),
    memberAccount: varchar({ length: 31 }).notNull(),
    memberDomain: varchar({ length: 63 }).notNull(),
    memberNamespaceId: integer().default(0).notNull(),
    operation: groupMetaMemberOperation().notNull(),
    body: jsonb().$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.targetNamespaceId, table.groupId, table.feedId],
      name: 'GroupMetaMemberFeed_pkey',
    }),
    index('GroupMetaMemberFeed_member_feed_idx').on(
      table.targetPeerDomain,
      table.targetNamespaceId,
      table.groupId,
      table.memberDomain,
      table.memberNamespaceId,
      table.memberAccount,
      table.feedId,
    ),
    foreignKey({
      columns: [table.memberNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'GroupMetaMemberFeed_memberNamespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.targetPeerDomain, table.targetNamespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'GroupMetaMemberFeed_targetNamespace_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [group.id],
      name: 'GroupMetaMemberFeed_groupId_fkey',
    }).onDelete('cascade'),
    check('GroupMetaMemberFeed_feedId_check', sql`${table.feedId} > 0`),
    check('GroupMetaMemberFeed_body_check', sql`${table.body} <> '{}'::jsonb`),
  ],
);

export const groupMetaFeedTarget = pgTable(
  'GroupMetaFeedTarget',
  {
    targetPeerDomain: varchar({ length: 63 }).notNull(),
    targetNamespaceId: integer().notNull(),
    groupId: integer().notNull(),
    allocatedThrough: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
    oldestAvailableAfter: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
    active: boolean().default(true).notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.targetNamespaceId, table.groupId],
      name: 'GroupMetaFeedTarget_pkey',
    }),
    foreignKey({
      columns: [table.targetPeerDomain, table.targetNamespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'GroupMetaFeedTarget_targetNamespace_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [group.id],
      name: 'GroupMetaFeedTarget_groupId_fkey',
    }).onDelete('cascade'),
    check(
      'GroupMetaFeedTarget_allocatedThrough_check',
      sql`${table.allocatedThrough} >= 0`,
    ),
    check(
      'GroupMetaFeedTarget_oldestAvailableAfter_check',
      sql`${table.oldestAvailableAfter} >= 0 AND ${table.oldestAvailableAfter} <= ${table.allocatedThrough}`,
    ),
  ],
);

/** Per-user device projection of one group's member feed. */
export const clientGroupMetaMemberFeed = pgTable(
  'ClientGroupMetaMemberFeed',
  {
    accountId: integer().notNull(),
    groupId: integer().notNull(),
    feedId: bigint({ mode: 'bigint' }).notNull(),
    memberAccount: varchar({ length: 31 }).notNull(),
    memberDomain: varchar({ length: 63 }).notNull(),
    memberNamespaceId: integer().default(0).notNull(),
    operation: groupMetaMemberOperation().notNull(),
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
      columns: [table.accountId, table.groupId, table.feedId],
      name: 'ClientGroupMetaMemberFeed_pkey',
    }),
    index('ClientGroupMetaMemberFeed_member_feed_idx').on(
      table.accountId,
      table.groupId,
      table.memberDomain,
      table.memberNamespaceId,
      table.memberAccount,
      table.feedId,
    ),
    foreignKey({
      columns: [table.memberNamespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'ClientGroupMetaMemberFeed_memberNamespaceId_fkey',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [account.id],
      name: 'ClientGroupMetaMemberFeed_accountId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [group.id],
      name: 'ClientGroupMetaMemberFeed_groupId_fkey',
    }).onDelete('cascade'),
    check('ClientGroupMetaMemberFeed_feedId_check', sql`${table.feedId} > 0`),
    check(
      'ClientGroupMetaMemberFeed_body_check',
      sql`(${table.operation} = 'UPSERT' AND ${table.body} <> '{}'::jsonb) OR (${table.operation} = 'DEPART' AND ${table.body} = '{}'::jsonb)`,
    ),
  ],
);

/** Allocation and retention boundary for a user's view of one group-member feed. */
export const clientGroupMetaFeedTarget = pgTable(
  'ClientGroupMetaFeedTarget',
  {
    accountId: integer().notNull(),
    groupId: integer().notNull(),
    allocatedThrough: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
    oldestAvailableAfter: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
    active: boolean().default(true).notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.groupId],
      name: 'ClientGroupMetaFeedTarget_pkey',
    }),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [account.id],
      name: 'ClientGroupMetaFeedTarget_accountId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.groupId],
      foreignColumns: [group.id],
      name: 'ClientGroupMetaFeedTarget_groupId_fkey',
    }).onDelete('cascade'),
    check(
      'ClientGroupMetaFeedTarget_allocatedThrough_check',
      sql`${table.allocatedThrough} >= 0`,
    ),
    check(
      'ClientGroupMetaFeedTarget_oldestAvailableAfter_check',
      sql`${table.oldestAvailableAfter} >= 0 AND ${table.oldestAvailableAfter} <= ${table.allocatedThrough}`,
    ),
  ],
);

/** Address-based federated friend intent. Pending/revoked intents deliberately do not require a
 * foreign User stub; the stub is materialized only after an ACCEPTED state proves the remote account
 * and the local user have converged. displayName/avatar are request-card snapshots, never identity
 * authority. */
export const federatedFriendRequest = pgTable(
  'FederatedFriendRequest',
  {
    localUserId: integer().notNull(),
    remoteAccount: varchar({ length: 31 }).notNull(),
    remoteDomain: varchar({ length: 63 }).notNull(),
    namespaceId: integer().notNull(),
    direction: varchar({ length: 16 }).notNull(),
    status: varchar({ length: 16 }).notNull(),
    note: varchar({ length: 255 }).default('').notNull(),
    requestedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    expiresAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    displayName: varchar({ length: 30 }),
    avatar: text(),
    profileRevision: integer(),
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
        table.localUserId,
        table.namespaceId,
        table.remoteAccount,
        table.direction,
      ],
      name: 'FederatedFriendRequest_pkey',
    }),
    index('FederatedFriendRequest_pending_idx').on(
      table.localUserId,
      table.direction,
      table.status,
      table.expiresAt,
    ),
    foreignKey({
      columns: [table.localUserId],
      foreignColumns: [account.id],
      name: 'FederatedFriendRequest_localUserId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.remoteDomain, table.namespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'FederatedFriendRequest_namespace_fkey',
    }).onDelete('restrict'),
    check(
      'FederatedFriendRequest_direction_check',
      sql`${table.direction} IN ('INCOMING', 'OUTGOING')`,
    ),
    check(
      'FederatedFriendRequest_status_check',
      sql`${table.status} IN ('REQUESTED', 'ACCEPTED', 'REVOKED')`,
    ),
    check(
      'FederatedFriendRequest_profileRevision_check',
      sql`${table.profileRevision} IS NULL OR ${table.profileRevision} >= 0`,
    ),
    check(
      'FederatedFriendRequest_expiry_check',
      sql`(${table.status} = 'REQUESTED' AND ${table.requestedAt} IS NOT NULL AND ${table.expiresAt} IS NOT NULL AND ${table.expiresAt} > ${table.requestedAt} AND ${table.expiresAt} <= ${table.requestedAt} + INTERVAL '7 days') OR (${table.status} = 'ACCEPTED' AND ${table.requestedAt} IS NOT NULL AND ${table.expiresAt} IS NULL) OR (${table.status} = 'REVOKED' AND ${table.expiresAt} IS NULL)`,
    ),
  ],
);

export const peerStateFeedPullCursor = pgTable(
  'PeerStateFeedPullCursor',
  {
    peerDomain: varchar({ length: 63 }).notNull(),
    namespaceId: integer().primaryKey().notNull(),
    initialized: boolean().default(false).notNull(),
    committedThrough: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.peerDomain, table.namespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'PeerStateFeedPullCursor_namespace_fkey',
    }).onDelete('restrict'),
    check(
      'PeerStateFeedPullCursor_committedThrough_check',
      sql`${table.committedThrough} >= 0`,
    ),
  ],
);

/** One authoritative directed request. A and B may each retain an independent row and note. */
export const relationshipIntent = pgTable(
  'RelationshipIntent',
  {
    id: bigserial({ mode: 'bigint' }).notNull(),
    pairId: bigint({ mode: 'bigint' }).notNull(),
    authorSide: varchar({ length: 1 }).notNull(),
    status: relationshipIntentStatus().notNull(),
    note: varchar({ length: 255 }).default('').notNull(),
    requestedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    expiresAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' }),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('RelationshipIntent_id_key').on(table.id),
    primaryKey({
      columns: [table.pairId, table.authorSide],
      name: 'RelationshipIntent_pkey',
    }),
    foreignKey({
      columns: [table.pairId],
      foreignColumns: [relationshipPair.id],
      name: 'RelationshipIntent_pairId_fkey',
    }).onDelete('cascade'),
    check(
      'RelationshipIntent_authorSide_check',
      sql`${table.authorSide} IN ('A', 'B')`,
    ),
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
    endpointADomain: varchar({ length: 63 }).notNull(),
    endpointANamespaceId: integer().default(0).notNull(),
    endpointBType: varchar({ length: 8 }).notNull(),
    endpointBAccount: varchar({ length: 31 }).notNull(),
    endpointBDomain: varchar({ length: 63 }).notNull(),
    endpointBNamespaceId: integer().default(0).notNull(),
    threadId: integer(),
    active: boolean().default(false).notNull(),
    revision: integer().default(0).notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    unique('RelationshipPair_endpoints_key')
      .on(
        table.endpointAType,
        table.endpointAAccount,
        table.endpointADomain,
        table.endpointANamespaceId,
        table.endpointBType,
        table.endpointBAccount,
        table.endpointBDomain,
        table.endpointBNamespaceId,
      ),
    index('RelationshipPair_endpointA_idx').on(
      table.endpointAType,
      table.endpointAAccount,
      table.endpointADomain,
      table.endpointANamespaceId,
      table.active,
    ),
    index('RelationshipPair_endpointB_idx').on(
      table.endpointBType,
      table.endpointBAccount,
      table.endpointBDomain,
      table.endpointBNamespaceId,
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
      'RelationshipPair_distinct_endpoints_check',
      sql`(${table.endpointAType}, ${table.endpointAAccount}, ${table.endpointADomain}) <> (${table.endpointBType}, ${table.endpointBAccount}, ${table.endpointBDomain})`,
    ),
    check('RelationshipPair_revision_check', sql`${table.revision} >= 0`),
  ],
);

/** Append-only group-domain audit trail. Identity fields are snapshots rather than foreign keys so
 * account deletion, federation-stub cleanup, or later profile edits cannot erase who performed an action. */
export const groupAuditLog = pgTable(
  'GroupAuditLog',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    eventKey: varchar({ length: 191 }).notNull(),
    groupId: integer(),
    groupAccount: varchar({ length: 31 }).notNull(),
    groupDomain: varchar({ length: 63 }).notNull(),
    actorType: varchar({ length: 24 }).notNull(),
    actorUserId: integer(),
    actorAccount: varchar({ length: 31 }).notNull(),
    actorDomain: varchar({ length: 63 }).notNull(),
    action: varchar({ length: 64 }).notNull(),
    targetType: varchar({ length: 32 }),
    targetId: varchar({ length: 191 }),
    success: boolean().default(true).notNull(),
    errorMessage: varchar({ length: 255 }),
    meta: jsonb(),
    at: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    uniqueIndex('GroupAuditLog_eventKey_key').on(table.eventKey),
    index('GroupAuditLog_groupId_at_idx').on(table.groupId, table.at),
    index('GroupAuditLog_action_at_idx').on(table.action, table.at),
  ],
);

/** A durable inclusive publisher-sequence interval not yet committed by reverse synchronization. */
export const federationThreadHistoryGap = pgTable(
  'FederationThreadHistoryGap',
  {
    id: bigserial({ mode: 'bigint' }).primaryKey().notNull(),
    threadId: integer().notNull(),
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
      table.id,
    ),
    uniqueIndex('FederationThreadHistoryGap_interval_key').on(
      table.threadId,
      table.startSeq,
      table.endSeq,
    ),
    index('FederationThreadHistoryGap_recoverable_idx')
      .on(table.threadId, table.endSeq)
      .where(sql`${table.recoverable} = true`),
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'FederationThreadHistoryGap_threadId_fkey',
    }).onDelete('cascade'),
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
    threadId: integer().primaryKey().notNull(),
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
    historyBoundaryReached: boolean().default(false).notNull(),
    updatedAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .default(sql`CURRENT_TIMESTAMP`)
      .notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.threadId],
      foreignColumns: [messageThread.id],
      name: 'FederationThreadSyncState_threadId_fkey',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.threadId, table.activeGapId],
      foreignColumns: [
        federationThreadHistoryGap.threadId,
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
    check(
      'FederationThreadSyncState_history_check',
      sql`NOT (${table.historyBoundaryReached} AND ${table.activeGapId} IS NOT NULL)`,
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
  },
  (table) => [
    index('SessionToken_lastSeenAt_active_idx')
      .using(
        'btree',
        table.lastSeenAt.desc().nullsFirst().op('timestamptz_ops'),
      )
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
      columns: [table.domain, table.namespaceId],
      foreignColumns: [identityNamespace.domain, identityNamespace.id],
      name: 'S2SKeyCache_namespace_fkey',
    }).onDelete('restrict'),
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
 * (domain, UTC day). The file-cnt dimension reuses QuotaDailyUsage with category 'files'; the byte dimension lives
 * here because byte totals exceed integer range. Drives the per-peer circuit breaker. See src/quota/quota.service.ts.
 */
export const quotaFileByteUsage = pgTable(
  'QuotaFileByteUsage',
  {
    domain: varchar({ length: 63 }).notNull(),
    date: date({ mode: 'date' }).notNull(),
    bytes: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
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
    bytes: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
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
    extraFileBytes: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.domain, table.date],
      name: 'QuotaDailyAllowance_pkey',
    }),
  ],
);

/**
 * Bounded Federation v1 call terminal cache. It survives a process restart only long enough to classify
 * signed retries and late frames; it is not a call-history table (the durable CALL message remains the CDR).
 */
export const callTombstone = pgTable(
  'CallTombstone',
  {
    peerDomain: varchar({ length: 253 }).notNull(),
    namespaceId: integer().notNull(),
    callSid: varchar({ length: 36 }).notNull(),
    terminalOp: varchar({ length: 16 }).notNull(),
    endReason: varchar({ length: 16 }),
    initialCallType: varchar({ length: 8 }).notNull(),
    finalCallType: varchar({ length: 8 }).notNull(),
    signalIds: jsonb().$type<string[]>().default([]).notNull(),
    expiresAt: timestamp({
      precision: 3,
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    createdAt: timestamp({ precision: 3, withTimezone: true, mode: 'date' })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.namespaceId, table.callSid],
      name: 'CallTombstone_pkey',
    }),
    foreignKey({
      columns: [table.namespaceId],
      foreignColumns: [identityNamespace.id],
      name: 'CallTombstone_namespaceId_fkey',
    }).onDelete('restrict'),
    index('CallTombstone_expiresAt_idx').on(table.expiresAt),
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
    extraFileBytes: bigint({ mode: 'bigint' }).default(sql`0`).notNull(),
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
