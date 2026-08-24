import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mintUlid } from '../common/account.js';
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
  threadParticipant,
} from '../database/schema.js';
import { ContentType } from '../database/enums.js';
import { isThreadMutuallyAuthorized } from '../invite/relationship-authorization.js';
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
  FederationAddress,
  FederationByteDescriptor,
  FederatedMessagePayload,
} from '../federation/federated-message-types.js';

export const FORWARD_MAX_MESSAGES = 500;
export const FORWARD_MAX_ASSETS = 500;
export const FORWARD_SUMMARY_LINES = 2;
export const FORWARD_SUMMARY_CHARS = 100;
export const FORWARD_QUOTE_PREVIEW_CHARS = 100;
export const FORWARD_MAX_WIRE_JSON_BYTES = 2 * 1024 * 1024;
export const FORWARD_MAX_CLOSURE_BUNDLES = 500;

export interface ForwardSourceMessage {
  threadId: number;
  seq: number;
}

export interface ForwardAuthorSnapshot extends FederationAddress {
  displayName: string;
  avatarDigest?: string;
}

export interface ForwardBundleMessage extends FederatedMessagePayload {
  /** Positive identity used only by quotes in this enclosing messages array. */
  id: number;
  author: ForwardAuthorSnapshot;
  sentAt: number;
  childBundleId?: string;
  quoteTargetId?: number;
}

export interface ForwardWireChild {
  id: string;
  messages: ForwardBundleMessage[];
}

export interface ForwardWireBundle {
  id: string;
  messages: ForwardBundleMessage[];
  children: ForwardWireChild[];
  assets: FederationByteDescriptor[];
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
    const memberships = await this.database.db.query.threadParticipant.findMany(
      {
        where: and(
          eq(threadParticipant.userId, userId),
          inArray(threadParticipant.threadId, uniqueThreads),
        ),
        columns: { threadId: true, clearedSeq: true, blocked: true },
        with: {
          messageThread: { columns: { type: true } },
        },
      },
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
            ),
            with: {
              user: {
                columns: {
                  account: true,
                  domain: true,
                  name: true,
                  avatar: true,
                },
              },
              forwardMessages: {
                with: { forwardBundle: true },
                limit: 1,
              },
            },
          })
          .then((row) =>
            row
              ? {
                  ...row,
                  creatorItem: row.user,
                  forwardMessage: row.forwardMessages[0]
                    ? {
                        ...row.forwardMessages[0],
                        bundle: row.forwardMessages[0].forwardBundle,
                      }
                    : null,
                }
              : null,
          ),
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
      const creatorItem = message.creatorItem;
      if (!creatorItem)
        throw new Error('user-authored forward source has no creator');
      const avatar = await this.snapshotAvatarForMessage(creatorItem.avatar);
      if (avatar) assets.set(this.assetKey(avatar), avatar);
      const mediaAssets = await this.assetsFromContent(
        message.contentType,
        message.content,
      );
      for (const asset of mediaAssets) assets.set(this.assetKey(asset), asset);
      messages.push({
        id: index + 1,
        author: {
          displayName: creatorItem.name,
          account: creatorItem.account,
          domain:
            creatorItem.domain === 'local'
              ? (process.env.SOMS_DOMAIN ?? 'local')
              : creatorItem.domain,
          ...(avatar ? { avatarDigest: avatar.digest } : {}),
        },
        contentType: message.contentType,
        content: localizeForwardMediaContent(
          message.contentType,
          message.content,
          mediaAssets,
        ),
        sentAt: message.createdAt.getTime(),
        ...(message.forwardMessage
          ? { childBundleId: message.forwardMessage.bundleId }
          : {}),
        ...(parseTextMessageContent(enrichedRows[index].content)?.quote &&
        selectedIndex.get(
          `${message.threadId}:${parseTextMessageContent(message.content)!.quote!.seq}`,
        ) !== undefined
          ? {
              quoteTargetId:
                selectedIndex.get(
                  `${message.threadId}:${parseTextMessageContent(message.content)!.quote!.seq}`,
                )! + 1,
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
    let descendantMessageCount = 0;
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
    descendantMessageCount = [...descendantBundles.values()].reduce(
      (sum, bundle) => sum + bundle.messages.length,
      0,
    );
    const assetList = [...assets.values()];
    const content = JSON.stringify({
      version: 1,
      bundleId,
      summaryLines: messages
        .slice(0, FORWARD_SUMMARY_LINES)
        .map((message) => this.summaryLine(message)),
      messageCount: messages.length + descendantMessageCount,
      assetCount: assetList.length,
    });
    return {
      bundleId,
      content,
      messages,
      assets: assetList,
      childBundleIds: [...descendantBundles.keys()],
      messageCount: messages.length + descendantMessageCount,
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
        threadParticipant,
        and(
          eq(threadParticipant.threadId, message.threadId),
          eq(threadParticipant.userId, userId),
        ),
      )
      .where(
        and(
          eq(forwardMessage.bundleId, rootBundleId),
          eq(message.isDeleted, false),
          sql`${message.seq} > COALESCE(${threadParticipant.clearedSeq}, 0)`,
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

  /** Rebuild receiver-local artwork for LINK snapshots after a federated bundle has committed. */
  async rebuildLinkCards(
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
    const digests = new Set<string>();
    for (const row of rows) {
      let changed = false;
      const messages = await Promise.all(
        (row.messages as ForwardBundleMessage[]).map(async (message) => {
          if (message.contentType !== ContentType.LINK) return message;
          const value = JSON.parse(message.content) as { url?: unknown };
          if (typeof value.url !== 'string') return message;
          const card = await build(value.url);
          changed = true;
          const content = JSON.stringify(card);
          extractDigests(content).forEach((digest) => digests.add(digest));
          return { ...message, content };
        }),
      );
      if (changed) rebuilt.push({ id: row.id, messages });
    }
    if (rebuilt.length === 0) return;
    const assets = await Promise.all(
      [...digests].map(async (digest) => {
        const row = await this.database.db.query.mediaAsset.findFirst({
          where: eq(mediaAsset.digest, digest),
        });
        return { digest, bytes: BigInt(row?.bytes ?? 1n) };
      }),
    );
    await this.database.db.transaction(async (tx) => {
      for (const item of rebuilt) {
        await tx
          .update(forwardBundle)
          .set({ messages: item.messages })
          .where(eq(forwardBundle.id, item.id));
      }
      if (assets.length > 0) {
        const existing = await tx.query.forwardBundleAsset.findMany({
          where: eq(forwardBundleAsset.bundleId, rootBundleId),
          columns: { digest: true, ordinal: true },
        });
        const known = new Set(existing.map((asset) => asset.digest));
        const additions = assets.filter((asset) => !known.has(asset.digest));
        if (additions.length > 0) {
          const start = existing.reduce(
            (max, asset) => Math.max(max, asset.ordinal + 1),
            0,
          );
          await tx.insert(forwardBundleAsset).values(
            additions.map((asset, index) => ({
              bundleId: rootBundleId,
              ordinal: start + index,
              ...asset,
            })),
          );
          await tx
            .update(forwardBundle)
            .set({
              assetCount: existing.length + additions.length,
              totalBytes: sql`${forwardBundle.totalBytes} + ${additions.reduce((sum, asset) => sum + asset.bytes, 0n)}`,
            })
            .where(eq(forwardBundle.id, rootBundleId));
        }
      }
    });
  }

  /**
   * Validate and localize a peer's complete flat bundle. Every wire id is replaced with a fresh local
   * ULID. Only the queryable parent id participates in cross-request import idempotency; child ids are
   * scoped to this one parent document and must never become global source identities.
   */
  async importClosure(
    sourceDomain: string,
    closure: ForwardWireBundle,
    transaction?: DatabaseTransaction,
  ): Promise<{ localRootBundleId: string }> {
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
    const expectedDigests = new Set<string>();
    const validateMessages = (messages: ForwardBundleMessage[]): void => {
      const ids = new Set<number>();
      for (const message of messages) {
        if (
          !Number.isSafeInteger(message.id) ||
          message.id < 1 ||
          ids.has(message.id) ||
          typeof message.author?.displayName !== 'string' ||
          typeof message.author?.account !== 'string' ||
          typeof message.author?.domain !== 'string' ||
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
        if (message.author.avatarDigest !== undefined) {
          if (!/^[a-f0-9]{64}$/.test(message.author.avatarDigest))
            throw this.invalidWire('invalid forward author avatar digest');
          expectedDigests.add(message.author.avatarDigest);
        }
        try {
          for (const digest of federatedContentDigests(
            message.contentType,
            message.content,
          ))
            expectedDigests.add(digest);
          projectForwardContentFromWire(message.contentType, message.content);
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
            message.quoteTargetId < 1 ||
            !ids.has(message.quoteTargetId))
        ) {
          throw this.invalidWire('invalid forward quote target');
        }
      }
    };
    validateMessages(closure.messages);
    for (const child of closure.children) validateMessages(child.messages);
    for (const asset of closure.assets) this.validateWireAsset(asset);
    const declaredDigests = new Set(
      closure.assets.map((asset) => asset.digest),
    );
    const actualMessageCount =
      closure.messages.length +
      closure.children.reduce((sum, child) => sum + child.messages.length, 0);
    if (
      actualMessageCount > FORWARD_MAX_MESSAGES ||
      closure.assets.length > FORWARD_MAX_ASSETS ||
      declaredDigests.size !== closure.assets.length ||
      declaredDigests.size !== expectedDigests.size ||
      [...expectedDigests].some((digest) => !declaredDigests.has(digest))
    ) {
      throw this.invalidWire('flat forward counts or assets do not match');
    }

    const client = transaction ?? this.database.db;
    const existing = await client.query.forwardBundle.findFirst({
      where: and(
        eq(forwardBundle.sourceDomain, sourceDomain),
        eq(forwardBundle.sourceBundleId, closure.id),
      ),
      columns: { id: true },
    });
    if (existing) return { localRootBundleId: existing.id };

    const idMap = new Map<string, string>([
      [closure.id, mintUlid()],
      ...closure.children.map((child) => [child.id, mintUlid()] as const),
    ]);
    const localizeMessages = (
      messages: ForwardBundleMessage[],
    ): ForwardBundleMessage[] =>
      messages.map((message) => ({
        ...message,
        content: projectForwardContentFromWire(
          message.contentType,
          message.content,
        ),
        ...(message.childBundleId
          ? {
              childBundleId: idMap.get(message.childBundleId)!,
              content: rewriteForwardCardBundleId(
                projectForwardContentFromWire(
                  message.contentType,
                  message.content,
                ),
                idMap.get(message.childBundleId)!,
              ),
            }
          : {}),
      }));
    const localRootId = idMap.get(closure.id)!;
    const persist = async (tx: DatabaseTransaction): Promise<void> => {
      const flat = [
        { remoteId: closure.id, messages: closure.messages, root: true },
        ...closure.children.map((child) => ({
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
          assetCount: item.root ? closure.assets.length : 0,
          totalBytes: item.root
            ? closure.assets.reduce(
                (sum, asset) => sum + BigInt(asset.bytes),
                0n,
              )
            : 0n,
          sourceDomain,
          sourceBundleId: item.root ? closure.id : null,
        });
      }
      if (closure.children.length > 0) {
        await tx.insert(forwardBundleDependency).values(
          closure.children.map((child, ordinal) => ({
            parentBundleId: localRootId,
            childBundleId: idMap.get(child.id)!,
            ordinal,
          })),
        );
      }
      if (closure.assets.length > 0) {
        await tx.insert(forwardBundleAsset).values(
          closure.assets.map((asset, ordinal) => ({
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
    return { localRootBundleId: localRootId };
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
    let meta: { size?: number } = {};
    try {
      meta = JSON.parse(content) as typeof meta;
    } catch {
      // IMAGE legacy content may not be JSON; digest extraction remains authoritative.
    }
    const result: FederationByteDescriptor[] = [];
    for (const { digest } of extractDigestEntries(content)) {
      const row = await this.database.db.query.mediaAsset.findFirst({
        where: eq(mediaAsset.digest, digest),
      });
      result.push({
        digest,
        bytes: Math.max(1, meta.size ?? Number(row?.bytes ?? 1n)),
      });
    }
    return result;
  }

  /** Build one digest/byte descriptor per GALLERY item. Digest comes from the item's CAS url; bytes fall back to the live
   *  MediaAsset row when the item omits size. */
  private async galleryAssetsFromContent(
    content: string,
  ): Promise<FederationByteDescriptor[]> {
    let items: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(content) as { items?: unknown };
      if (Array.isArray(parsed.items)) {
        items = parsed.items as Array<Record<string, unknown>>;
      }
    } catch {
      // malformed gallery content → no assets
    }
    const result: FederationByteDescriptor[] = [];
    for (const item of items) {
      const url = typeof item['url'] === 'string' ? item['url'] : undefined;
      const digest = url ? extractDigests(url)[0] : undefined;
      if (!digest) continue;
      const size = typeof item['size'] === 'number' ? item['size'] : undefined;
      const row = await this.database.db.query.mediaAsset.findFirst({
        where: eq(mediaAsset.digest, digest),
      });
      result.push({
        digest,
        bytes: Math.max(1, size ?? Number(row?.bytes ?? 1n)),
      });
    }
    return result;
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

  private summaryLine(message: ForwardBundleMessage): string {
    const preview = deriveMessagePreview(
      message.contentType,
      message.content,
      toDisplayText,
    );
    return truncateGraphemes(
      `${message.author.displayName}：${preview}`,
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

  localCardContent(closure: ForwardWireBundle, localBundleId: string): string {
    const messages = [
      ...closure.messages,
      ...closure.children.flatMap((child) => child.messages),
    ];
    return JSON.stringify({
      version: 1,
      bundleId: localBundleId,
      summaryLines: messages
        .slice(0, FORWARD_SUMMARY_LINES)
        .map((message) => this.summaryLine(message)),
      messageCount: messages.length,
      assetCount: closure.assets.length,
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
): string {
  if (!isFederatedContentType(contentType)) {
    throw new Error('invalid forward content type');
  }
  return fromFederatedMessageContent(
    contentType,
    content,
    process.env.SOMS_DOMAIN ?? 'local',
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
  // GALLERY: rebind every item's url to the canonical CAS path from its digest (only for items whose
  // digest is bound to a bundle asset — unbound items are left untouched).
  if (contentType === ContentType.GALLERY) {
    try {
      const value = JSON.parse(content) as { items?: unknown };
      if (!Array.isArray(value.items)) return content;
      const bound = new Set(assets.map((a) => a.digest));
      const items = (value.items as Array<Record<string, unknown>>).map(
        (item) => {
          const url =
            typeof item['url'] === 'string' ? (item['url'] as string) : '';
          const digest = url ? extractDigests(url)[0] : undefined;
          if (!digest || !bound.has(digest)) return item;
          return {
            ...item,
            url: `/uploads/msg-assets/${digest.slice(0, 2)}/${digest.slice(2, 4)}/${digest}`,
          };
        },
      );
      return JSON.stringify({ ...value, items });
    } catch {
      return content;
    }
  }
  if (!isForwardDirectMedia(contentType)) return content;
  const digests = extractDigests(content);
  const asset =
    digests.length === 1
      ? assets.find((candidate) => candidate.digest === digests[0])
      : undefined;
  if (!asset) return content;
  try {
    const value = JSON.parse(content) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return content;
    }
    return JSON.stringify({
      ...(value as Record<string, unknown>),
      url: `/uploads/msg-assets/${asset.digest.slice(0, 2)}/${asset.digest.slice(2, 4)}/${asset.digest}`,
    });
  } catch {
    return content;
  }
}
