import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  isValidSomfpDomain,
  isValidSomfpUserAccount,
  mintUlid,
} from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { dataDirectory } from '../common/data-directory.js';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  forwardBundle,
  forwardBundleAsset,
  forwardBundleDependency,
  forwardMessage,
  mediaAsset,
  messageAsset,
  message,
  messageThread,
  accountThreadState,
} from '../database/schema.js';
import { ContentType } from '../database/enums.js';
import { isThreadMutuallyAuthorized } from '../relationship/shared/relationship-authorization.js';
import {
  federatedContentDigests,
  fromFederatedMessageContent,
  toFederatedMessageContent,
} from '../federation/federated-message-content.js';
import {
  extractDigestEntries,
  extractDigests,
  type LinkContent,
} from '../upload/file-content.js';
import { toDisplayText } from '../common/message-entity.js';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';
import { deriveMessagePreview } from '../../shared/message-preview.js';
import { MessageService } from '../message/message.service.js';
import { MessageVisibilityService } from '../message/message-visibility.service.js';
import type {
  FederationByteDescriptor,
  FederatedMessagePayload,
} from '../federation/federated-message-types.js';

const FORWARD_MAX_MESSAGES = 500;
const FORWARD_MAX_DEPTH = 3;
const FORWARD_MAX_ASSETS = 500;
const FORWARD_SUMMARY_LINES = 2;
const FORWARD_SUMMARY_CHARS = 100;
export const FORWARD_MAX_WIRE_JSON_BYTES = 2 * 1024 * 1024;
const FORWARD_MAX_CLOSURE_BUNDLES = 500;

export interface ForwardSourceMessage {
  threadId: number;
  seq: number;
}

interface ForwardAuthor {
  /** Optional stable identity. Account and domain are either both present or both absent. */
  account?: string;
  domain?: string;
}

interface ForwardProfileSnapshot {
  displayName: string;
  avatarDigest?: string;
}

export interface ForwardBundleMessage extends FederatedMessagePayload {
  /** Positive identity used only by quotes in this enclosing messages array. */
  id: number;
  author: ForwardAuthor;
  profile: ForwardProfileSnapshot;
  sentAt: number;
  childBundleId?: string;
  quoteTargetId?: number;
}

interface ForwardWireChild {
  id: string;
  messages: ForwardBundleMessage[];
}

export interface ForwardWireBundle {
  id: string;
  messages: ForwardBundleMessage[];
  children: ForwardWireChild[];
  assets: FederationByteDescriptor[];
}

/**
 * A forward bundle exactly as received off the wire — no field is trusted yet. Peer input
 * enters the system with this type; only importClosure's runtime validation (envelope shape,
 * field ranges, digest agreement) stands between it and ForwardWireBundle. Bundles we build
 * ourselves (buildClosure) are ForwardWireBundle from birth and never pass through here.
 */
export interface InboundForwardWireBundle {
  id: unknown;
  messages: unknown;
  children: unknown;
  assets: unknown;
}

/** Browser-facing bundle response. The carrier authorizes every snapshot asset URL in the closure. */
export interface ForwardBundleView extends ForwardWireBundle {
  accessContext: { threadId: number; seq: number };
}

export interface PreparedForwardBundle {
  bundleId: string;
  content: string;
  messages: ForwardBundleMessage[];
  assets: FederationByteDescriptor[];
  /** Every nested bundle id, flattened for one-pass storage/query. */
  childBundleIds: string[];
  messageCount: number;
  createdBy: number;
}

export interface DirectForwardSource {
  content: string;
  contentType: ContentType;
  forwardBundleId?: string;
}

@Injectable()
export class ForwardBundleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly messagesService: MessageService,
    private readonly messageVisibility: MessageVisibilityService,
  ) {}

  /** Resolve a single source through the normal message visibility boundary and remove reply context. */
  async prepareDirectMessage(
    userId: number,
    source: ForwardSourceMessage,
  ): Promise<DirectForwardSource> {
    const visible = await this.messageVisibility.findVisibleByThreadSeq(
      userId,
      source.threadId,
      source.seq,
    );
    if (!visible) {
      throw new BusinessException(
        BusinessCode.FORWARD_INVALID_BUNDLE,
        'source message is inaccessible',
      );
    }

    const directTypes: ReadonlySet<ContentType> = new Set([
      ContentType.PURE_TEXT,
      ContentType.IMAGE,
      ContentType.VIDEO,
      ContentType.AUDIO,
      ContentType.FILE,
      ContentType.LINK,
      ContentType.CONTACT_CARD,
      ContentType.GALLERY,
      ContentType.FORWARD,
    ]);
    if (!directTypes.has(visible.contentType)) {
      throw new BusinessException(
        BusinessCode.FORWARD_INVALID_BUNDLE,
        'message type cannot be forwarded directly',
      );
    }

    const parsedText =
      visible.contentType === ContentType.PURE_TEXT
        ? parseTextMessageContent(visible.content)
        : null;
    const content = parsedText
      ? stringifyTextMessageContent({ text: parsedText.text })
      : visible.content;

    const isAttachedMedia =
      visible.contentType === ContentType.IMAGE ||
      visible.contentType === ContentType.FILE ||
      visible.contentType === ContentType.VIDEO ||
      visible.contentType === ContentType.AUDIO;
    // GALLERY carries N item digests; single-file attached media must reference exactly one.
    if (
      isAttachedMedia ||
      visible.contentType === ContentType.GALLERY ||
      visible.contentType === ContentType.CONTACT_CARD
    ) {
      const digests = extractDigests(visible.content);
      if (isAttachedMedia && digests.length !== 1) {
        throw new BusinessException(
          BusinessCode.FORWARD_INVALID_BUNDLE,
          'source media is invalid',
        );
      }
      if (digests.length > 0) {
        const bindings = await this.database.db.query.messageAsset.findMany({
          where: and(
            eq(messageAsset.messageId, visible.id),
            inArray(messageAsset.digest, digests),
          ),
          columns: { digest: true },
        });
        const bound = new Set(bindings.map((binding) => binding.digest));
        if (digests.some((digest) => !bound.has(digest))) {
          throw new BusinessException(
            BusinessCode.FORWARD_INVALID_BUNDLE,
            'source media is inaccessible',
          );
        }
      }
    }

    if (visible.contentType !== ContentType.FORWARD) {
      return { content, contentType: visible.contentType };
    }
    const binding = await this.database.db.query.forwardMessage.findFirst({
      where: eq(forwardMessage.messageId, visible.id),
    });
    if (!binding) {
      throw new BusinessException(
        BusinessCode.FORWARD_INVALID_BUNDLE,
        'forward source binding not found',
      );
    }
    return {
      content,
      contentType: visible.contentType,
      forwardBundleId: binding.bundleId,
    };
  }

  async createFromMessages(
    userId: number,
    sources: ForwardSourceMessage[],
  ): Promise<{
    bundleId: string;
    content: string;
  }> {
    const prepared = await this.prepareFromMessages(userId, sources);
    await this.database.db.transaction((tx) =>
      this.persistPrepared(tx, prepared),
    );
    return prepared;
  }

  async prepareFromMessages(
    userId: number,
    sources: ForwardSourceMessage[],
  ): Promise<PreparedForwardBundle> {
    if (sources.length < 1 || sources.length > FORWARD_MAX_MESSAGES) {
      throw new BusinessException(
        BusinessCode.FORWARD_INVALID_BUNDLE,
        `forward must contain 1-${FORWARD_MAX_MESSAGES} messages`,
      );
    }
    const sourceThreadId = sources[0].threadId;
    for (let index = 1; index < sources.length; index++) {
      const previous = sources[index - 1];
      const current = sources[index];
      if (current.threadId !== sourceThreadId || current.seq <= previous.seq) {
        throw new BusinessException(
          BusinessCode.FORWARD_INVALID_BUNDLE,
          'source messages must belong to one thread and be strictly ordered by seq',
        );
      }
    }
    const uniqueThreads = [...new Set(sources.map((s) => s.threadId))];
    const memberships = await this.database.db
      .select({
        threadId: accountThreadState.threadId,
        clearedSeq: messageThread.clearedSeq,
        blocked: accountThreadState.blocked,
        messageThread,
      })
      .from(accountThreadState)
      .innerJoin(
        messageThread,
        eq(messageThread.id, accountThreadState.threadId),
      )
      .where(
        and(
          eq(accountThreadState.accountId, userId),
          inArray(accountThreadState.threadId, uniqueThreads),
        ),
      );
    const authorizedMemberships = (
      await Promise.all(
        memberships.map(async (membership) => ({
          membership,
          authorized: await isThreadMutuallyAuthorized(
            this.database.db,
            userId,
            membership.threadId,
          ),
        })),
      )
    )
      .filter((entry) => entry.authorized)
      .map((entry) => entry.membership);
    if (authorizedMemberships.length !== uniqueThreads.length) {
      throw new BusinessException(
        BusinessCode.FORWARD_INVALID_BUNDLE,
        'one or more source messages are inaccessible',
      );
    }
    const sourceRows = await Promise.all(
      sources.map((source) =>
        this.database.db.query.message
          .findFirst({
            where: and(
              eq(message.threadId, source.threadId),
              eq(message.seq, source.seq),
              eq(message.localState, 'READY'),
            ),
            with: {
              forwardMessages: {
                with: { forwardBundle: true },
                limit: 1,
              },
            },
          })
          .then(async (row) => {
            if (!row) return null;
            const creatorProfile =
              row.creatorAccount === null || row.creatorDomain === null
                ? null
                : await this.exactProfileForMessage({
                    account: row.creatorAccount,
                    domain: row.creatorDomain,
                    namespaceId: row.creatorNamespaceId,
                    profileRev: row.profileRev,
                  });
            return {
              ...row,
              creatorProfile,
              forwardMessage: row.forwardMessages[0]
                ? {
                    ...row.forwardMessages[0],
                    bundle: row.forwardMessages[0].forwardBundle,
                  }
                : null,
            };
          }),
      ),
    );
    if (sourceRows.some((row) => row === null || row.isDeleted)) {
      throw new BusinessException(
        BusinessCode.FORWARD_INVALID_BUNDLE,
        'one or more source messages do not exist',
      );
    }

    const quoteFilters = new Map(
      authorizedMemberships.map((membership) => [
        membership.threadId,
        {
          clearedThroughSeq: membership.clearedSeq,
        },
      ]),
    );
    if (
      sourceRows.some((row) => {
        const visibility = quoteFilters.get(row!.threadId);
        const membership = authorizedMemberships.find(
          (candidate) => candidate.threadId === row!.threadId,
        );
        return (
          membership?.blocked === true ||
          (visibility?.clearedThroughSeq !== null &&
            visibility?.clearedThroughSeq !== undefined &&
            row!.seq <= visibility.clearedThroughSeq)
        );
      })
    ) {
      throw new BusinessException(
        BusinessCode.FORWARD_INVALID_BUNDLE,
        'one or more source messages are inaccessible',
      );
    }
    const childBundleIds = [
      ...new Set(
        sourceRows.flatMap((row) =>
          row!.forwardMessage ? [row!.forwardMessage.bundleId] : [],
        ),
      ),
    ];
    // Local cards carry trusted snapshot metadata; only HISTORY adds a layer.
    let depth = 1;
    let messageCount = sources.length;
    for (const row of sourceRows) {
      if (!row!.forwardMessage) continue;
      let child: { bundleId: string; depth: number; messageCount: number };
      try {
        child = parseLocalForwardCard(row!.content);
      } catch {
        throw new BusinessException(
          BusinessCode.FORWARD_INVALID_BUNDLE,
          'forward source card is invalid',
        );
      }
      if (child.bundleId !== row!.forwardMessage.bundleId) {
        throw new BusinessException(
          BusinessCode.FORWARD_INVALID_BUNDLE,
          'forward source card does not match its binding',
        );
      }
      depth = Math.max(depth, 1 + child.depth);
      messageCount += child.messageCount;
    }
    if (depth > FORWARD_MAX_DEPTH) {
      throw new BusinessException(
        BusinessCode.FORWARD_MAX_DEPTH_EXCEEDED,
        `forward bundle depth cannot exceed ${FORWARD_MAX_DEPTH}`,
      );
    }
    if (messageCount > FORWARD_MAX_MESSAGES) {
      throw new BusinessException(
        BusinessCode.FORWARD_INVALID_BUNDLE,
        `forward cannot exceed ${FORWARD_MAX_MESSAGES} messages`,
      );
    }

    const enrichedRows = await this.messagesService.attachQuotePreviews(
      sourceRows.map((row) => row!),
      quoteFilters,
    );

    const bundleId = mintUlid();
    const assets = new Map<string, FederationByteDescriptor>();
    const selectedIndex = new Map(
      sources.map((source, index) => [
        `${source.threadId}:${source.seq}`,
        index,
      ]),
    );
    const messages: ForwardBundleMessage[] = [];
    for (const [index, row] of sourceRows.entries()) {
      const message = row!;
      if (message.contentType === ContentType.SYSTEM) {
        throw new BusinessException(
          BusinessCode.FORWARD_INVALID_BUNDLE,
          'system messages cannot be forwarded',
        );
      }
      if (message.creatorAccount === null || message.creatorDomain === null)
        throw new Error('user-authored forward source has no creator');
      const avatar = message.creatorProfile?.avatar
        ? await this.snapshotAvatarForMessage(message.creatorProfile.avatar)
        : null;
      const profile = {
        // Forward display names are mandatory. A missing exact historical profile degrades to the
        // immutable creator account captured by the source message, never to a mutable profile.
        displayName:
          message.creatorProfile?.displayName ?? message.creatorAccount,
        ...(avatar ? { avatarDigest: avatar.digest } : {}),
      };
      if (avatar) assets.set(this.assetKey(avatar), avatar);
      const mediaAssets = await this.assetsFromContent(
        message.contentType,
        message.content,
      );
      for (const asset of mediaAssets) assets.set(this.assetKey(asset), asset);
      const text =
        message.contentType === ContentType.PURE_TEXT
          ? parseTextMessageContent(message.content)
          : null;
      const resolvedQuote = parseTextMessageContent(
        enrichedRows[index].content,
      )?.quote;
      const selectedTarget =
        resolvedQuote && resolvedQuote.seq > 0
          ? selectedIndex.get(`${message.threadId}:${resolvedQuote.seq}`)
          : undefined;
      messages.push({
        id: index + 1,
        author: {
          account: message.creatorAccount,
          domain:
            message.creatorDomain === 'local'
              ? (process.env.SOMS_DOMAIN ?? 'local')
              : message.creatorDomain,
        },
        profile,
        contentType: message.contentType,
        content: localizeForwardMediaContent(
          message.contentType,
          text
            ? stringifyTextMessageContent({ text: text.text })
            : message.content,
          mediaAssets,
        ),
        sentAt: message.createdAt.getTime(),
        ...(message.forwardMessage
          ? { childBundleId: message.forwardMessage.bundleId }
          : {}),
        ...(text?.quote
          ? {
              quoteTargetId:
                selectedTarget === undefined ? 0 : selectedTarget + 1,
            }
          : {}),
      });
    }
    const children = [
      ...new Set(
        messages.flatMap((m) => (m.childBundleId ? [m.childBundleId] : [])),
      ),
    ];
    const descendantBundles = new Map<string, ForwardWireChild>();
    for (const childBundleId of children) {
      const closure = await this.buildClosure(childBundleId);
      descendantBundles.set(closure.id, {
        id: closure.id,
        messages: closure.messages,
      });
      for (const child of closure.children)
        descendantBundles.set(child.id, child);
      for (const asset of closure.assets)
        assets.set(this.assetKey(asset), asset);
    }
    const assetList = [...assets.values()];
    const content = JSON.stringify({
      bundleId,
      summaryLines: messages
        .slice(0, FORWARD_SUMMARY_LINES)
        .map((message) => this.summaryLine(message)),
      messageCount,
      depth,
    });
    return {
      bundleId,
      content,
      messages,
      assets: assetList,
      childBundleIds: [...descendantBundles.keys()],
      messageCount,
      createdBy: userId,
    };
  }

  async persistPrepared(
    tx: DatabaseTransaction,
    prepared: PreparedForwardBundle,
  ): Promise<void> {
    await tx.insert(forwardBundle).values({
      id: prepared.bundleId,
      messages: prepared.messages,
      messageCount: prepared.messageCount,
      assetCount: prepared.assets.length,
      totalBytes: prepared.assets.reduce(
        (sum, asset) => sum + BigInt(asset.bytes),
        0n,
      ),
      createdBy: prepared.createdBy,
    });
    if (prepared.childBundleIds.length > 0) {
      await tx.insert(forwardBundleDependency).values(
        prepared.childBundleIds.map((childBundleId, ordinal) => ({
          parentBundleId: prepared.bundleId,
          childBundleId,
          ordinal,
        })),
      );
    }
    if (prepared.assets.length > 0) {
      await tx.insert(forwardBundleAsset).values(
        prepared.assets.map((asset, ordinal) => ({
          bundleId: prepared.bundleId,
          ordinal,
          digest: asset.digest,
          bytes: BigInt(asset.bytes),
        })),
      );
    }
  }

  async getClosureForUser(
    userId: number,
    rootBundleId: string,
  ): Promise<ForwardBundleView> {
    const carriers = await this.database.db
      .select({ threadId: message.threadId, seq: message.seq })
      .from(forwardMessage)
      .innerJoin(message, eq(message.id, forwardMessage.messageId))
      .innerJoin(
        accountThreadState,
        and(
          eq(accountThreadState.threadId, message.threadId),
          eq(accountThreadState.accountId, userId),
        ),
      )
      .where(
        and(
          eq(forwardMessage.bundleId, rootBundleId),
          eq(message.isDeleted, false),
        ),
      );
    let carrier: { threadId: number; seq: number } | null = null;
    for (const candidate of carriers) {
      if (
        await this.messageVisibility.findVisibleByThreadSeq(
          userId,
          candidate.threadId,
          candidate.seq,
        )
      ) {
        carrier = candidate;
        break;
      }
    }
    if (!carrier) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'forward bundle not found',
      );
    }
    return {
      ...(await this.buildClosure(rootBundleId)),
      accessContext: carrier,
    };
  }

  async buildClosure(rootBundleId: string): Promise<ForwardWireBundle> {
    const root = await this.database.db.query.forwardBundle.findFirst({
      where: eq(forwardBundle.id, rootBundleId),
      with: {
        forwardBundleDependencies_parentBundleId: {
          orderBy: asc(forwardBundleDependency.ordinal),
        },
        forwardBundleAssets: { orderBy: asc(forwardBundleAsset.ordinal) },
      },
    });
    if (!root) throw this.invalidWire('forward root bundle is missing');
    const childIds = root.forwardBundleDependencies_parentBundleId.map(
      (dependency) => dependency.childBundleId,
    );
    if (childIds.length > FORWARD_MAX_CLOSURE_BUNDLES) {
      throw this.invalidWire(
        `forward bundle cannot exceed ${FORWARD_MAX_CLOSURE_BUNDLES} children`,
      );
    }
    const rows = await this.database.db.query.forwardBundle.findMany({
      where: inArray(forwardBundle.id, childIds),
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const projectMessages = (row: typeof root) => {
      const storedMessages = row.messages as ForwardBundleMessage[];
      return storedMessages.map((message) => ({
        ...message,
        content: projectForwardContentToWire(
          message.contentType,
          message.content,
        ),
      }));
    };
    const messages = projectMessages(root);
    const children = childIds.map((id) => {
      const row = byId.get(id);
      if (!row) throw this.invalidWire('forward child bundle is missing');
      return { id, messages: projectMessages(row as typeof root) };
    });
    return {
      id: rootBundleId,
      messages,
      children,
      assets: (root.forwardBundleAssets ?? []).map((asset) =>
        this.assetDocument(asset),
      ),
    };
  }

  /** Apply the opt-in untrusted-resource policy after a federated bundle commits: LINK snapshots are
   *  rebuilt locally, while CONTACT_CARD avatars are removed because the snapshot carries no
   *  independently resolvable profile coordinate. The root manifest is then reconciled exactly. */
  async rebuildUntrustedCards(
    rootBundleId: string,
    build: (url: string) => Promise<LinkContent>,
  ): Promise<void> {
    const root = await this.database.db.query.forwardBundle.findFirst({
      where: eq(forwardBundle.id, rootBundleId),
      with: { forwardBundleDependencies_parentBundleId: true },
    });
    if (!root) return;
    const ids = [
      rootBundleId,
      ...root.forwardBundleDependencies_parentBundleId.map(
        (dependency) => dependency.childBundleId,
      ),
    ];
    const rows = await this.database.db.query.forwardBundle.findMany({
      where: inArray(forwardBundle.id, ids),
    });
    const rebuilt: Array<{
      id: string;
      messages: ForwardBundleMessage[];
    }> = [];
    for (const row of rows) {
      let changed = false;
      const messages = await Promise.all(
        (row.messages as ForwardBundleMessage[]).map(async (message) => {
          if (message.contentType === ContentType.CONTACT_CARD) {
            const value = JSON.parse(message.content) as Record<
              string,
              unknown
            >;
            if (value['avatar'] === undefined) return message;
            const withoutAvatar = { ...value };
            delete withoutAvatar['avatar'];
            changed = true;
            return { ...message, content: JSON.stringify(withoutAvatar) };
          }
          if (message.contentType !== ContentType.LINK) return message;
          const value = JSON.parse(message.content) as { url?: unknown };
          if (typeof value.url !== 'string') return message;
          const card = await build(value.url);
          changed = true;
          const content = JSON.stringify(card);
          return { ...message, content };
        }),
      );
      if (changed) rebuilt.push({ id: row.id, messages });
    }
    if (rebuilt.length === 0) return;
    const rebuiltById = new Map(
      rebuilt.map((item) => [item.id, item.messages]),
    );
    const digests = new Set<string>();
    for (const row of rows) {
      const messages =
        rebuiltById.get(row.id) ?? (row.messages as ForwardBundleMessage[]);
      for (const message of messages) {
        if (message.profile.avatarDigest) {
          digests.add(message.profile.avatarDigest);
        }
        extractDigests(message.content).forEach((digest) =>
          digests.add(digest),
        );
      }
    }
    const existing = await this.database.db.query.forwardBundleAsset.findMany({
      where: eq(forwardBundleAsset.bundleId, rootBundleId),
      columns: { digest: true, bytes: true },
    });
    const existingBytes = new Map(
      existing.map((asset) => [asset.digest, asset.bytes]),
    );
    const assets = await Promise.all(
      [...digests].map(async (digest) => {
        const row = await this.database.db.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digest),
        });
        return {
          digest,
          bytes: BigInt(row?.bytes ?? existingBytes.get(digest) ?? 1n),
        };
      }),
    );
    await this.database.db.transaction(async (tx) => {
      for (const item of rebuilt) {
        await tx
          .update(forwardBundle)
          .set({ messages: item.messages })
          .where(eq(forwardBundle.id, item.id));
      }
      await tx
        .delete(forwardBundleAsset)
        .where(eq(forwardBundleAsset.bundleId, rootBundleId));
      if (assets.length > 0) {
        await tx.insert(forwardBundleAsset).values(
          assets.map((asset, ordinal) => ({
            bundleId: rootBundleId,
            ordinal,
            ...asset,
          })),
        );
      }
      await tx
        .update(forwardBundle)
        .set({
          assetCount: assets.length,
          totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0n),
        })
        .where(eq(forwardBundle.id, rootBundleId));
    });
  }

  /**
   * Validate and localize a peer's complete flat bundle. Every wire id is replaced with a fresh local
   * ULID. Only the queryable parent id participates in cross-request import idempotency; child ids are
   * scoped to this one parent document and must never become global source identities.
   *
   * This is the trust boundary for peer bundles: `closure` is deliberately
   * InboundForwardWireBundle (untrusted), and the runtime checks below — not the parameter
   * type — are what make it a ForwardWireBundle.
   */
  async importClosure(
    sourceDomain: string,
    closure: InboundForwardWireBundle,
    transaction?: DatabaseTransaction,
  ): Promise<{ localRootBundleId: string; depth: number }> {
    if (
      Buffer.byteLength(JSON.stringify(closure)) >
        FORWARD_MAX_WIRE_JSON_BYTES ||
      !isForwardBundleId(closure.id) ||
      !Array.isArray(closure.messages) ||
      !Array.isArray(closure.children) ||
      !Array.isArray(closure.assets) ||
      closure.children.length > FORWARD_MAX_CLOSURE_BUNDLES
    ) {
      throw this.invalidWire('invalid flat forward bundle envelope');
    }
    const childIds = new Set<string>();
    for (const child of closure.children) {
      if (
        !isForwardBundleId(child.id) ||
        child.id === closure.id ||
        childIds.has(child.id) ||
        !Array.isArray(child.messages)
      ) {
        throw this.invalidWire('invalid flat forward child');
      }
      childIds.add(child.id);
    }
    const assetBytes = new Map<string, number>();
    for (const asset of closure.assets) {
      this.validateWireAsset(asset);
      assetBytes.set(asset.digest, asset.bytes);
    }
    const expectedDigests = new Set<string>();
    const validateMessages = (messages: ForwardBundleMessage[]): void => {
      const ids = new Set<number>();
      for (const message of messages) {
        if (
          Object.keys(message).some(
            (key) =>
              ![
                'id',
                'author',
                'profile',
                'contentType',
                'content',
                'sentAt',
                'childBundleId',
                'quoteTargetId',
              ].includes(key),
          ) ||
          !Number.isSafeInteger(message.id) ||
          message.id < 1 ||
          ids.has(message.id) ||
          message.author === null ||
          typeof message.author !== 'object' ||
          Array.isArray(message.author) ||
          (message.author.account !== undefined &&
            typeof message.author.account !== 'string') ||
          (message.author.domain !== undefined &&
            typeof message.author.domain !== 'string') ||
          (message.author.account === undefined) !==
            (message.author.domain === undefined) ||
          (message.author.account !== undefined &&
            !isValidSomfpUserAccount(message.author.account)) ||
          (message.author.domain !== undefined &&
            !isValidSomfpDomain(message.author.domain)) ||
          Object.keys(message.author).some(
            (key) => key !== 'account' && key !== 'domain',
          ) ||
          message.profile === null ||
          typeof message.profile !== 'object' ||
          Array.isArray(message.profile) ||
          typeof message.profile.displayName !== 'string' ||
          [...message.profile.displayName].length < 1 ||
          [...message.profile.displayName].length > 31 ||
          Object.keys(message.profile).some(
            (key) => key !== 'displayName' && key !== 'avatarDigest',
          ) ||
          !Number.isSafeInteger(message.sentAt) ||
          message.sentAt < 0 ||
          !isFederatedContentType(message.contentType) ||
          typeof message.content !== 'string' ||
          (message.childBundleId !== undefined &&
            !childIds.has(message.childBundleId))
        ) {
          throw this.invalidWire('invalid flat forward message');
        }
        ids.add(message.id);
        if (message.profile.avatarDigest !== undefined) {
          if (!/^[a-f0-9]{64}$/.test(message.profile.avatarDigest))
            throw this.invalidWire('invalid forward profile avatar digest');
          expectedDigests.add(message.profile.avatarDigest);
        }
        try {
          for (const digest of federatedContentDigests(
            message.contentType,
            message.content,
          ))
            expectedDigests.add(digest);
          projectForwardContentFromWire(
            message.contentType,
            message.content,
            assetBytes,
          );
        } catch {
          throw this.invalidWire('invalid forward message content');
        }
        if (
          (message.contentType === ContentType.FORWARD) !==
          (message.childBundleId !== undefined)
        ) {
          throw this.invalidWire('forward child reference is inconsistent');
        }
        if (message.contentType === ContentType.FORWARD) {
          try {
            const card = parseForwardCard(message.content);
            if (card.bundleId !== message.childBundleId) {
              throw new Error('child id mismatch');
            }
          } catch {
            throw this.invalidWire('forward card references a different child');
          }
        }
      }
      for (const message of messages) {
        if (
          message.quoteTargetId !== undefined &&
          (!Number.isSafeInteger(message.quoteTargetId) ||
            message.quoteTargetId < 0)
        ) {
          throw this.invalidWire('invalid forward quote target');
        }
      }
    };
    validateMessages(closure.messages);
    for (const child of closure.children) validateMessages(child.messages);
    const declaredDigests = new Set(
      closure.assets.map((asset) => asset.digest),
    );
    if (
      closure.assets.length > FORWARD_MAX_ASSETS ||
      declaredDigests.size !== closure.assets.length ||
      declaredDigests.size !== expectedDigests.size ||
      [...expectedDigests].some((digest) => !declaredDigests.has(digest))
    ) {
      throw this.invalidWire('flat forward counts or assets do not match');
    }

    const depth = this.validateClosureGraph(
      closure as ForwardWireBundle,
      (reason) => this.invalidWire(reason),
    );

    // Every runtime check above passed: the wire bundle now satisfies ForwardWireBundle.
    // This is the single untrusted→trusted crossing; everything below rests on the
    // validation, not on the parameter type.
    const wire = closure as ForwardWireBundle;

    const actualMessageCount =
      wire.messages.length +
      wire.children.reduce((sum, child) => sum + child.messages.length, 0);
    const client = transaction ?? this.database.db;
    const existing = await client.query.forwardBundle.findFirst({
      where: and(
        eq(forwardBundle.sourceDomain, sourceDomain),
        eq(forwardBundle.sourceBundleId, wire.id),
      ),
      columns: { id: true },
    });
    if (existing) return { localRootBundleId: existing.id, depth };

    const idMap = new Map<string, string>([
      [wire.id, mintUlid()],
      ...wire.children.map((child) => [child.id, mintUlid()] as const),
    ]);
    const localizeMessages = (
      messages: ForwardBundleMessage[],
    ): ForwardBundleMessage[] =>
      messages.map((message) => ({
        ...message,
        content: projectForwardContentFromWire(
          message.contentType,
          message.content,
          assetBytes,
        ),
        ...(message.childBundleId
          ? {
              childBundleId: idMap.get(message.childBundleId)!,
              content: rewriteForwardCardBundleId(
                projectForwardContentFromWire(
                  message.contentType,
                  message.content,
                  assetBytes,
                ),
                idMap.get(message.childBundleId)!,
              ),
            }
          : {}),
      }));
    const localRootId = idMap.get(wire.id)!;
    const persist = async (tx: DatabaseTransaction): Promise<void> => {
      const flat = [
        { remoteId: wire.id, messages: wire.messages, root: true },
        ...wire.children.map((child) => ({
          remoteId: child.id,
          messages: child.messages,
          root: false,
        })),
      ];
      for (const item of flat) {
        const localMessages = localizeMessages(item.messages);
        const localId = idMap.get(item.remoteId)!;
        await tx.insert(forwardBundle).values({
          id: localId,
          messages: localMessages,
          messageCount: item.root ? actualMessageCount : localMessages.length,
          assetCount: item.root ? wire.assets.length : 0,
          totalBytes: item.root
            ? wire.assets.reduce((sum, asset) => sum + BigInt(asset.bytes), 0n)
            : 0n,
          sourceDomain,
          sourceBundleId: item.root ? wire.id : null,
        });
      }
      if (wire.children.length > 0) {
        await tx.insert(forwardBundleDependency).values(
          wire.children.map((child, ordinal) => ({
            parentBundleId: localRootId,
            childBundleId: idMap.get(child.id)!,
            ordinal,
          })),
        );
      }
      if (wire.assets.length > 0) {
        await tx.insert(forwardBundleAsset).values(
          wire.assets.map((asset, ordinal) => ({
            bundleId: localRootId,
            ordinal,
            digest: asset.digest,
            bytes: BigInt(asset.bytes),
          })),
        );
      }
    };
    if (transaction) await persist(transaction);
    else await this.database.db.transaction(persist);
    return { localRootBundleId: localRootId, depth };
  }

  /** The flat closure is an index of bundles; message references define its actual tree. */
  private validateClosureGraph(
    closure: Pick<ForwardWireBundle, 'id' | 'messages' | 'children'>,
    invalid: (reason: string) => BusinessException,
  ): number {
    const bundles = new Map<string, ForwardBundleMessage[]>([
      [closure.id, closure.messages],
      ...closure.children.map((child) => [child.id, child.messages] as const),
    ]);
    const states = new Map<string, 'visiting' | 'visited'>();
    let messageCount = 0;
    const depth = (id: string): number => {
      if (states.get(id) === 'visiting')
        throw invalid('forward bundle dependency cycle detected');
      if (states.get(id) === 'visited')
        throw invalid('forward bundle is referenced more than once');
      const messages = bundles.get(id);
      if (!messages) throw invalid('forward child bundle is missing');
      states.set(id, 'visiting');
      messageCount += messages.length;
      if (messageCount > FORWARD_MAX_MESSAGES)
        throw invalid(`forward cannot exceed ${FORWARD_MAX_MESSAGES} messages`);
      let maxDepth = 1;
      for (const message of messages) {
        if (message.childBundleId !== undefined) {
          maxDepth = Math.max(maxDepth, 1 + depth(message.childBundleId));
        }
      }
      states.set(id, 'visited');
      return maxDepth;
    };
    const actualDepth = depth(closure.id);
    if (actualDepth > FORWARD_MAX_DEPTH)
      throw invalid(`forward bundle depth cannot exceed ${FORWARD_MAX_DEPTH}`);
    if (states.size !== bundles.size)
      throw invalid('forward closure contains unreachable children');
    return actualDepth;
  }

  private async assetsFromContent(
    contentType: ContentType,
    content: string,
  ): Promise<FederationByteDescriptor[]> {
    if (contentType === ContentType.GALLERY) {
      return this.galleryAssetsFromContent(content);
    }
    if (
      contentType === ContentType.LINK ||
      contentType === ContentType.CONTACT_CARD
    ) {
      const result: FederationByteDescriptor[] = [];
      for (const digest of extractDigests(content)) {
        const row = await this.database.db.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digest),
        });
        result.push({
          digest,
          bytes: Math.max(1, Number(row?.bytes ?? 1n)),
        });
      }
      return result;
    }
    if (!isForwardDirectMedia(contentType)) return [];
    return extractDigestEntries(content).map(({ digest, size }) => {
      if (size === undefined || !Number.isSafeInteger(size) || size < 1) {
        throw new Error('Stored media content has an invalid size');
      }
      return { digest, bytes: size };
    });
  }

  /** Build one digest/byte descriptor per current-schema GALLERY item. */
  private async galleryAssetsFromContent(
    content: string,
  ): Promise<FederationByteDescriptor[]> {
    const parsed = JSON.parse(content) as unknown;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      !Array.isArray((parsed as { items?: unknown }).items)
    ) {
      throw new Error('Stored gallery content is malformed');
    }
    return (parsed as { items: unknown[] }).items.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Stored gallery item is malformed');
      }
      const record = item as Record<string, unknown>;
      const digest =
        typeof record.url === 'string'
          ? extractDigests(record.url)[0]
          : undefined;
      if (
        !digest ||
        typeof record.size !== 'number' ||
        !Number.isSafeInteger(record.size) ||
        record.size < 1
      ) {
        throw new Error('Stored gallery item has invalid media metadata');
      }
      return { digest, bytes: record.size };
    });
  }

  async snapshotAvatarForMessage(
    url: string,
  ): Promise<FederationByteDescriptor | null> {
    if (!url.startsWith('/uploads/')) return null;
    try {
      const source = dataDirectory('uploads', url.slice('/uploads/'.length));
      const buffer = await readFile(source);
      const digest = createHash('sha256').update(buffer).digest('hex');
      const target = dataDirectory(
        'cas',
        digest.slice(0, 2),
        digest.slice(2, 4),
        digest,
      );
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${mintUlid()}.tmp`;
      let renamed = false;
      try {
        await writeFile(temporary, buffer);
        await rename(temporary, target);
        renamed = true;
      } finally {
        if (!renamed) await unlink(temporary).catch(() => {});
      }
      await this.database.db
        .insert(mediaAsset)
        .values({ digest, bytes: BigInt(buffer.length), isDeleted: false })
        .onConflictDoUpdate({
          target: mediaAsset.digest,
          set: { bytes: BigInt(buffer.length), isDeleted: false },
        });
      return {
        digest,
        bytes: buffer.length,
      };
    } catch {
      return null;
    }
  }

  private async exactProfileForMessage(selector: {
    account: string;
    domain: string;
    namespaceId: number;
    profileRev: number;
  }): Promise<{ displayName: string; avatar: string } | null> {
    const result = await this.database.db.execute<{
      displayName: string;
      avatar: string;
    }>(sql`
      SELECT snapshot."displayName", snapshot.avatar
      FROM "Profile" snapshot
      WHERE snapshot.account = ${selector.account}
        AND snapshot.domain = ${selector.domain}
        AND snapshot."namespaceId" = ${selector.namespaceId}
        AND snapshot."profileRev" = ${selector.profileRev}
      LIMIT 1
    `);
    const profile = result.rows[0];
    return profile
      ? { displayName: profile.displayName, avatar: profile.avatar }
      : null;
  }

  private summaryLine(message: ForwardBundleMessage): string {
    const preview = deriveMessagePreview(
      message.contentType,
      message.content,
      toDisplayText,
    );
    return truncateGraphemes(
      `${message.profile.displayName}：${preview}`,
      FORWARD_SUMMARY_CHARS,
    );
  }

  private assetDocument(asset: {
    digest: string;
    bytes: bigint;
  }): FederationByteDescriptor {
    return {
      digest: asset.digest,
      bytes: Number(asset.bytes),
    };
  }

  private assetKey(asset: FederationByteDescriptor): string {
    return asset.digest;
  }

  private validateWireAsset(asset: FederationByteDescriptor): void {
    if (
      !/^[0-9a-f]{64}$/.test(asset.digest) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1
    ) {
      throw this.invalidWire('invalid forward asset descriptor');
    }
  }

  assetsFromClosure(closure: ForwardWireBundle): FederationByteDescriptor[] {
    return closure.assets;
  }

  localCardContent(
    closure: ForwardWireBundle,
    localBundleId: string,
    depth: number,
  ): string {
    const messages = [
      ...closure.messages,
      ...closure.children.flatMap((child) => child.messages),
    ];
    return JSON.stringify({
      bundleId: localBundleId,
      summaryLines: messages
        .slice(0, FORWARD_SUMMARY_LINES)
        .map((message) => this.summaryLine(message)),
      messageCount: messages.length,
      depth,
    });
  }

  private invalidWire(message: string): BusinessException {
    return new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}

function truncateGraphemes(value: string, max: number): string {
  const Segmenter = Intl.Segmenter;
  const segments = [
    ...new Segmenter('zh-CN', { granularity: 'grapheme' }).segment(value),
  ];
  return segments.length <= max
    ? value
    : `${segments
        .slice(0, Math.max(0, max - 1))
        .map((item) => item.segment)
        .join('')}…`;
}

function isForwardDirectMedia(contentType: string): boolean {
  return (
    contentType === ContentType.IMAGE ||
    contentType === ContentType.FILE ||
    contentType === ContentType.VIDEO ||
    contentType === ContentType.AUDIO
  );
}

function isFederatedContentType(value: string): value is ContentType {
  return (
    value !== ContentType.SYSTEM &&
    Object.values(ContentType).includes(value as ContentType)
  );
}

function isForwardBundleId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= 26 &&
    !value.includes('\0') &&
    !value.includes('/')
  );
}

function parseForwardCard(content: string): { bundleId: string } {
  const value = JSON.parse(content) as { bundleId?: unknown };
  if (
    typeof value !== 'object' ||
    value === null ||
    typeof value.bundleId !== 'string'
  ) {
    throw new Error('invalid forward card');
  }
  return { bundleId: value.bundleId };
}

function parseLocalForwardCard(content: string): {
  bundleId: string;
  depth: number;
  messageCount: number;
} {
  const value = JSON.parse(content) as Record<string, unknown>;
  if (
    value === null ||
    typeof value !== 'object' ||
    !isForwardBundleId(value['bundleId']) ||
    !Number.isSafeInteger(value['depth']) ||
    (value['depth'] as number) < 1 ||
    (value['depth'] as number) > FORWARD_MAX_DEPTH ||
    !Number.isSafeInteger(value['messageCount']) ||
    (value['messageCount'] as number) < 1 ||
    (value['messageCount'] as number) > FORWARD_MAX_MESSAGES
  ) {
    throw new Error('invalid local forward card');
  }
  return {
    bundleId: value['bundleId'] as string,
    depth: value['depth'] as number,
    messageCount: value['messageCount'] as number,
  };
}

function rewriteForwardCardBundleId(content: string, bundleId: string): string {
  const value = JSON.parse(content) as Record<string, unknown>;
  return JSON.stringify({ ...value, bundleId });
}

function projectForwardContentToWire(
  contentType: string,
  content: string,
): string {
  if (!isFederatedContentType(contentType)) return content;
  return toFederatedMessageContent(
    contentType,
    content,
    process.env.SOMS_DOMAIN ?? 'local',
  );
}

function projectForwardContentFromWire(
  contentType: string,
  content: string,
  assetBytes: ReadonlyMap<string, number>,
): string {
  if (!isFederatedContentType(contentType)) {
    throw new Error('invalid forward content type');
  }
  return fromFederatedMessageContent(
    contentType,
    content,
    process.env.SOMS_DOMAIN ?? 'local',
    assetBytes,
  );
}

/**
 * A localized bundle never retains the source server's media URL. The digest is the wire identity;
 * rebuild the complete server-relative CAS path from the validated bundle asset.
 */
export function localizeForwardMediaContent(
  contentType: string,
  content: string,
  assets: FederationByteDescriptor[],
): string {
  // GALLERY: rebind every item's URL to the canonical CAS path from its bound asset.
  if (contentType === ContentType.GALLERY) {
    const value = JSON.parse(content) as unknown;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      !Array.isArray((value as { items?: unknown }).items)
    ) {
      throw new Error('Forward gallery content is malformed');
    }
    const bound = new Set(assets.map((asset) => asset.digest));
    const items = (value as { items: unknown[] }).items.map((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('Forward gallery item is malformed');
      }
      const record = item as Record<string, unknown>;
      const digest =
        typeof record.url === 'string'
          ? extractDigests(record.url)[0]
          : undefined;
      if (!digest || !bound.has(digest)) {
        throw new Error('Forward gallery item has no bound asset');
      }
      return {
        ...record,
        url: `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
      };
    });
    return JSON.stringify({ ...(value as Record<string, unknown>), items });
  }
  if (!isForwardDirectMedia(contentType)) return content;
  const digests = extractDigests(content);
  const asset =
    digests.length === 1
      ? assets.find((candidate) => candidate.digest === digests[0])
      : undefined;
  if (!asset) throw new Error('Forward media content has no bound asset');
  const value = JSON.parse(content) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Forward media content is malformed');
  }
  return JSON.stringify({
    ...(value as Record<string, unknown>),
    url: `/uploads/msg-assets/${asset.digest.slice(0, 2)}/${asset.digest.slice(2, 4)}/${asset.digest}`,
  });
}
