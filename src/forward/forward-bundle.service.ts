import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { mintUlid } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
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
import {
  federatedContentDigests,
  fromFederatedMessageContent,
  toFederatedMessageContent,
} from '../federation/federated-message-content.js';
import {
  extractDigestEntries,
  extractDigests,
  parseFileExt,
} from '../upload/file-content.js';
import { toDisplayText } from '../common/message-entity.js';
import {
  parseTextMessageContent,
  stringifyTextMessageContent,
} from '../../shared/text-message-content.js';
import { MessageService } from '../message/message.service.js';
import { UserBlockService } from '../user-block/user-block.service.js';
import { MessageVisibilityService } from '../message/message-visibility.service.js';

export const FORWARD_MAX_DEPTH = 3;
export const FORWARD_MAX_MESSAGES = 100;
export const FORWARD_SUMMARY_LINES = 3;
export const FORWARD_SUMMARY_CHARS = 100;
export const FORWARD_QUOTE_PREVIEW_CHARS = 100;
export const FORWARD_MAX_WIRE_JSON_BYTES = 2 * 1024 * 1024;
export const FORWARD_MAX_CLOSURE_BUNDLES = 500;

export interface ForwardSourceMessage {
  threadId: number;
  seq: number;
}

export interface ForwardAssetDocument {
  digest: string;
  kind: 'avatar' | 'image' | 'file' | 'video' | 'audio' | 'link';
  extension: string;
  bytes: number;
  filename?: string;
  mime?: string;
}

export interface ForwardManifestMessage {
  /** Positive Bundle-local identity used only by quotes within this manifest. */
  id: number;
  sender: {
    displayName: string;
    account: string;
    domain: string;
    avatarDigest?: string;
  };
  contentType: string;
  content: string;
  sentAt: number;
  childBundleId?: string;
  quote?: {
    preview: string;
    /** Bundle-local id of the quoted message; absent when it was not selected for this bundle. */
    targetId?: number;
  };
}

export interface ForwardManifest {
  schemaVersion: 1;
  bundleId: string;
  depth: number;
  children: string[];
  messages: ForwardManifestMessage[];
}

export interface ForwardWireBundle {
  id: string;
  depth: number;
  manifestDigest: string;
  manifest: ForwardManifest;
  assets: ForwardAssetDocument[];
}

export interface ForwardWireClosure {
  schemaVersion: 1;
  rootBundleId: string;
  bundles: ForwardWireBundle[];
  assets: ForwardAssetDocument[];
  accessContext?: { threadId: number; seq: number };
}

export interface PreparedForwardBundle {
  bundleId: string;
  depth: number;
  content: string;
  manifest: ForwardManifest;
  manifestDigest: string;
  assets: ForwardAssetDocument[];
  createdBy: number;
  /** Number of bundles in the closure (root + all descendants) — each counts as ONE file for quota. */
  bundleCount: number;
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
    private readonly userBlockService: UserBlockService,
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
      visible.contentType === ContentType.LINK
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
    depth: number;
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
          isNull(threadParticipant.leftAt),
        ),
        columns: { threadId: true, clearedSeq: true },
        with: {
          messageThread: { columns: { type: true } },
        },
      },
    );
    if (memberships.length !== uniqueThreads.length) {
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

    const blocked = await this.userBlockService.blockedByMe(userId);
    const quoteFilters = new Map(
      memberships.map((membership) => [
        membership.threadId,
        {
          clearedThroughSeq: membership.clearedSeq,
          ...(membership.messageThread.type === 'P2P' && blocked.size > 0
            ? { hideCreatorIds: [...blocked] }
            : {}),
        },
      ]),
    );
    if (
      sourceRows.some((row) => {
        const visibility = quoteFilters.get(row!.threadId);
        return (
          (visibility?.clearedThroughSeq !== null &&
            visibility?.clearedThroughSeq !== undefined &&
            row!.seq <= visibility.clearedThroughSeq) ||
          visibility?.hideCreatorIds?.includes(row!.creator)
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

    const childBundles = sourceRows
      .map((row) => row!.forwardMessage?.bundle)
      .filter(
        (bundle): bundle is NonNullable<typeof bundle> => bundle !== undefined,
      );
    const deepestChild = childBundles.reduce(
      (max, bundle) => Math.max(max, bundle.depth),
      0,
    );
    const depth = deepestChild + 1;
    if (depth > FORWARD_MAX_DEPTH) {
      throw new BusinessException(
        BusinessCode.FORWARD_MAX_DEPTH_EXCEEDED,
        `forward nesting depth cannot exceed ${FORWARD_MAX_DEPTH}`,
      );
    }

    const bundleId = mintUlid();
    const assets = new Map<string, ForwardAssetDocument>();
    const selectedIndex = new Map(
      sources.map((source, index) => [
        `${source.threadId}:${source.seq}`,
        index,
      ]),
    );
    const messages: ForwardManifestMessage[] = [];
    for (const [index, row] of sourceRows.entries()) {
      const message = row!;
      const avatar = await this.snapshotAvatar(message.creatorItem.avatar);
      if (avatar) assets.set(this.assetKey(avatar), avatar);
      const mediaAssets = await this.assetsFromContent(
        message.contentType,
        message.content,
      );
      for (const asset of mediaAssets) assets.set(this.assetKey(asset), asset);
      messages.push({
        id: index + 1,
        sender: {
          displayName: message.creatorItem.name,
          account: message.creatorItem.account,
          domain:
            message.creatorItem.domain === 'local'
              ? (process.env.SOMS_DOMAIN ?? 'local')
              : message.creatorItem.domain,
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
        ...(parseTextMessageContent(enrichedRows[index].content)?.quote
          ? {
              quote: {
                preview: (() => {
                  const reply = parseTextMessageContent(
                    enrichedRows[index].content,
                  )?.quote;
                  return reply
                    ? `${reply.author ?? ''}：${reply.body ?? ''}`
                    : '';
                })(),
                ...(selectedIndex.get(
                  `${message.threadId}:${parseTextMessageContent(message.content)!.quote!.seq}`,
                ) !== undefined
                  ? {
                      targetId:
                        selectedIndex.get(
                          `${message.threadId}:${parseTextMessageContent(message.content)!.quote!.seq}`,
                        )! + 1,
                    }
                  : {}),
              },
            }
          : {}),
      });
    }
    const children = [
      ...new Set(
        messages.flatMap((m) => (m.childBundleId ? [m.childBundleId] : [])),
      ),
    ];
    const manifest: ForwardManifest = {
      schemaVersion: 1,
      bundleId,
      depth,
      children,
      messages,
    };
    const descendantBundles = new Map<string, ForwardWireBundle>();
    for (const childBundleId of children) {
      const closure = await this.buildClosure(childBundleId);
      for (const bundle of closure.bundles)
        descendantBundles.set(bundle.id, bundle);
    }
    // Quota: each bundle in the closure (root + all descendant child bundles) counts as ONE file; inner
    // messages no longer count toward msg cnt (only the outer forward message does).
    const bundleCount = 1 + descendantBundles.size;
    const manifestDigest = digestManifest(manifest);
    const assetList = [...assets.values()];
    const content = JSON.stringify({
      version: 1,
      bundleId,
      summaryLines: messages
        .slice(0, FORWARD_SUMMARY_LINES)
        .map((message) => this.summaryLine(message)),
      messageCount: messages.length,
      assetCount: assetList.length,
    });
    return {
      bundleId,
      depth,
      content,
      manifest,
      manifestDigest,
      assets: assetList,
      createdBy: userId,
      bundleCount,
    };
  }

  async persistPrepared(
    tx: DatabaseTransaction,
    prepared: PreparedForwardBundle,
  ): Promise<void> {
    await tx.insert(forwardBundle).values({
      id: prepared.bundleId,
      depth: prepared.depth,
      manifest: prepared.manifest,
      manifestDigest: prepared.manifestDigest,
      messageCount: prepared.manifest.messages.length,
      assetCount: prepared.assets.length,
      totalBytes: prepared.assets.reduce(
        (sum, asset) => sum + BigInt(asset.bytes),
        0n,
      ),
      createdBy: prepared.createdBy,
    });
    if (prepared.manifest.children.length > 0) {
      await tx.insert(forwardBundleDependency).values(
        prepared.manifest.children.map((childBundleId, ordinal) => ({
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
          kind: asset.kind,
          extension: asset.extension,
          bytes: BigInt(asset.bytes),
          filename: asset.filename,
          mime: asset.mime,
        })),
      );
    }
  }

  async getClosureForUser(
    userId: number,
    rootBundleId: string,
  ): Promise<ForwardWireClosure> {
    const ancestors = await this.database.db.execute(sql<{ bundleId: string }>`
      WITH RECURSIVE ancestors("bundleId") AS (
        SELECT ${rootBundleId}::varchar
        UNION
        SELECT dependency."parentBundleId"
        FROM ancestors current
        JOIN "ForwardBundleDependency" dependency
          ON dependency."childBundleId" = current."bundleId"
      )
      SELECT "bundleId" FROM ancestors
    `);
    const ancestorIds = (ancestors.rows as Array<{ bundleId: string }>).map(
      (row) => row.bundleId,
    );
    const carriers = await this.database.db
      .select({ threadId: message.threadId, seq: message.seq })
      .from(forwardMessage)
      .innerJoin(message, eq(message.id, forwardMessage.messageId))
      .innerJoin(
        threadParticipant,
        and(
          eq(threadParticipant.threadId, message.threadId),
          eq(threadParticipant.userId, userId),
          isNull(threadParticipant.leftAt),
        ),
      )
      .where(
        and(
          inArray(forwardMessage.bundleId, ancestorIds),
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
    const closure = await this.buildClosure(rootBundleId);
    return {
      ...closure,
      accessContext: carrier,
    };
  }

  async buildClosure(rootBundleId: string): Promise<ForwardWireClosure> {
    const orderedIds: string[] = [];
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const visit = async (id: string): Promise<void> => {
      if (visiting.has(id))
        throw this.invalidWire('forward bundle contains a cycle');
      if (visited.has(id)) return;
      if (visited.size + visiting.size >= FORWARD_MAX_CLOSURE_BUNDLES) {
        throw this.invalidWire(
          `forward closure cannot exceed ${FORWARD_MAX_CLOSURE_BUNDLES} bundles`,
        );
      }
      visiting.add(id);
      const row = await this.database.db.query.forwardBundle.findFirst({
        where: eq(forwardBundle.id, id),
        with: {
          forwardBundleDependencies_parentBundleId: {
            orderBy: asc(forwardBundleDependency.ordinal),
          },
        },
      });
      if (!row) throw this.invalidWire('forward child bundle is missing');
      for (const child of row.forwardBundleDependencies_parentBundleId)
        await visit(child.childBundleId);
      visiting.delete(id);
      visited.add(id);
      orderedIds.push(id);
    };
    await visit(rootBundleId);
    const rows = await this.database.db.query.forwardBundle.findMany({
      where: inArray(forwardBundle.id, orderedIds),
      with: {
        forwardBundleAssets: { orderBy: asc(forwardBundleAsset.ordinal) },
      },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const bundles = orderedIds.map((id) => {
      const row = byId.get(id)!;
      const storedManifest = row.manifest as unknown as ForwardManifest;
      const manifest: ForwardManifest = {
        ...storedManifest,
        messages: storedManifest.messages.map((message) => ({
          ...message,
          content: projectForwardContentToWire(
            message.contentType,
            message.content,
          ),
        })),
      };
      return {
        id: row.id,
        depth: row.depth,
        manifestDigest: digestManifest(manifest),
        manifest,
        assets: row.forwardBundleAssets.map((asset) =>
          this.assetDocument(asset),
        ),
      };
    });
    const assets = new Map<string, ForwardAssetDocument>();
    for (const bundle of bundles) {
      for (const asset of bundle.assets)
        assets.set(this.assetKey(asset), asset);
    }
    const closure: ForwardWireClosure = {
      schemaVersion: 1,
      rootBundleId,
      bundles,
      assets: [...assets.values()],
    };
    if (
      Buffer.byteLength(JSON.stringify(closure)) > FORWARD_MAX_WIRE_JSON_BYTES
    ) {
      throw new BusinessException(
        BusinessCode.FEDERATION_PAYLOAD_TOO_LARGE,
        'forward bundle JSON exceeds 2 MiB',
        HttpStatus.OK,
      );
    }
    return closure;
  }

  /**
   * Validate and localize a peer's complete JSON closure. Every remote id is replaced with a fresh
   * local ULID; sourceDomain/sourceBundleId preserve import idempotency. Children are inserted before
   * parents, matching buildClosure's topological wire order.
   */
  async importClosure(
    sourceDomain: string,
    closure: ForwardWireClosure,
    transaction?: DatabaseTransaction,
  ): Promise<{ localRootBundleId: string }> {
    const bytes = Buffer.byteLength(JSON.stringify(closure));
    if (bytes > FORWARD_MAX_WIRE_JSON_BYTES) {
      throw this.invalidWire('forward bundle JSON exceeds 2 MiB');
    }
    if (
      closure.schemaVersion !== 1 ||
      !Array.isArray(closure.bundles) ||
      !Array.isArray(closure.assets) ||
      closure.bundles.length === 0 ||
      closure.bundles.length > FORWARD_MAX_CLOSURE_BUNDLES
    ) {
      throw this.invalidWire('invalid forward bundle envelope');
    }
    const remote = new Map(
      closure.bundles.map((bundle) => [bundle.id, bundle]),
    );
    if (
      !remote.has(closure.rootBundleId) ||
      remote.size !== closure.bundles.length
    ) {
      throw this.invalidWire('duplicate or missing root bundle');
    }
    const calculated = new Map<string, number>();
    const visiting = new Set<string>();
    const depthOf = (id: string): number => {
      const cached = calculated.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id))
        throw this.invalidWire('forward bundle contains a cycle');
      const bundle = remote.get(id);
      if (!bundle || bundle.manifest.bundleId !== id) {
        throw this.invalidWire('forward child bundle is missing');
      }
      if (
        digestManifest(bundle.manifest) !== bundle.manifestDigest ||
        !Array.isArray(bundle.manifest.children) ||
        !Array.isArray(bundle.manifest.messages) ||
        bundle.manifest.messages.length < 1 ||
        bundle.manifest.messages.length > FORWARD_MAX_MESSAGES ||
        !Array.isArray(bundle.assets)
      ) {
        throw this.invalidWire('forward manifest digest mismatch');
      }
      for (const asset of bundle.assets) this.validateWireAsset(asset);
      const messageIds = new Set<number>();
      const expectedAssetDigests = new Set<string>();
      const childReferences: string[] = [];
      for (const message of bundle.manifest.messages) {
        if (
          !Number.isSafeInteger(message.id) ||
          message.id < 1 ||
          messageIds.has(message.id) ||
          typeof message.content !== 'string' ||
          typeof message.contentType !== 'string' ||
          typeof message.sender?.displayName !== 'string' ||
          typeof message.sender?.account !== 'string' ||
          typeof message.sender?.domain !== 'string' ||
          !Number.isFinite(message.sentAt) ||
          (message.childBundleId !== undefined &&
            !bundle.manifest.children.includes(message.childBundleId))
        ) {
          throw this.invalidWire('invalid forward message descriptor');
        }
        messageIds.add(message.id);
        if (!isFederatedContentType(message.contentType)) {
          throw this.invalidWire('invalid forward content type');
        }
        if (message.sender.avatarDigest !== undefined) {
          if (!/^[0-9a-f]{64}$/.test(message.sender.avatarDigest)) {
            throw this.invalidWire('invalid forward sender avatar digest');
          }
          expectedAssetDigests.add(message.sender.avatarDigest);
        }
        try {
          for (const digest of federatedContentDigests(
            message.contentType,
            message.content,
          )) {
            expectedAssetDigests.add(digest);
          }
          projectForwardContentFromWire(message.contentType, message.content);
        } catch {
          throw this.invalidWire('invalid forward message content');
        }
        if (message.childBundleId !== undefined) {
          if (message.contentType !== ContentType.FORWARD) {
            throw this.invalidWire(
              'forward child is attached to a non-FORWARD message',
            );
          }
          let card: unknown;
          try {
            card = JSON.parse(message.content);
          } catch {
            throw this.invalidWire('invalid inner FORWARD card');
          }
          if (
            !card ||
            typeof card !== 'object' ||
            Array.isArray(card) ||
            (card as Record<string, unknown>)['bundleId'] !==
              message.childBundleId
          ) {
            throw this.invalidWire(
              'inner FORWARD card does not match its child',
            );
          }
          childReferences.push(message.childBundleId);
        } else if (message.contentType === ContentType.FORWARD) {
          throw this.invalidWire('inner FORWARD message is missing its child');
        }
        const mediaKind = forwardMediaKind(message.contentType);
        if (mediaKind) {
          let mediaContent: unknown;
          try {
            mediaContent = JSON.parse(message.content);
          } catch {
            throw this.invalidWire('invalid forward media content');
          }
          if (typeof mediaContent !== 'object' || mediaContent === null) {
            throw this.invalidWire('invalid forward media content');
          }
          let localized: string;
          try {
            localized = projectForwardContentFromWire(
              message.contentType,
              message.content,
            );
          } catch {
            throw this.invalidWire('invalid forward media content');
          }
          const digests = extractDigests(localized);
          if (
            digests.length !== 1 ||
            !bundle.assets.some(
              (asset) =>
                asset.kind === mediaKind && asset.digest === digests[0],
            )
          ) {
            throw this.invalidWire(
              'forward media content is not bound to a bundle asset',
            );
          }
        }
        // GALLERY: validate the items[] envelope and that every item digest is bound to a bundle asset
        // (the single-media bind check above only covers IMAGE/FILE/VIDEO/AUDIO).
        if (message.contentType === ContentType.GALLERY) {
          let galleryParsed: unknown;
          try {
            galleryParsed = JSON.parse(message.content);
          } catch {
            throw this.invalidWire('invalid forward gallery content');
          }
          const galleryItems = Array.isArray(
            (galleryParsed as { items?: unknown })?.items,
          )
            ? (galleryParsed as { items: unknown[] }).items
            : null;
          if (!galleryItems) {
            throw this.invalidWire('invalid forward gallery content');
          }
          let localized: string;
          try {
            localized = projectForwardContentFromWire(
              message.contentType,
              message.content,
            );
          } catch {
            throw this.invalidWire('invalid forward gallery content');
          }
          const galleryDigests = extractDigests(localized);
          if (
            galleryDigests.length === 0 ||
            galleryDigests.some(
              (d) => !bundle.assets.some((a) => a.digest === d),
            )
          ) {
            throw this.invalidWire(
              'forward gallery content is not bound to bundle assets',
            );
          }
        }
      }
      const declaredAssetDigests = new Set(
        bundle.assets.map((asset) => asset.digest),
      );
      if (
        declaredAssetDigests.size !== bundle.assets.length ||
        declaredAssetDigests.size !== expectedAssetDigests.size ||
        [...expectedAssetDigests].some(
          (digest) => !declaredAssetDigests.has(digest),
        )
      ) {
        throw this.invalidWire('forward bundle assets do not match content');
      }
      if (
        new Set(bundle.manifest.children).size !==
          bundle.manifest.children.length ||
        childReferences.length !== bundle.manifest.children.length ||
        new Set(childReferences).size !== childReferences.length ||
        childReferences.some(
          (child) => !bundle.manifest.children.includes(child),
        )
      ) {
        throw this.invalidWire(
          'forward child references do not match children',
        );
      }
      if (
        bundle.manifest.messages.some((message) => {
          const quote = message.quote;
          if (quote === undefined) return false;
          if (
            quote === null ||
            typeof quote !== 'object' ||
            Array.isArray(quote) ||
            typeof quote.preview !== 'string' ||
            truncateGraphemes(quote.preview, FORWARD_QUOTE_PREVIEW_CHARS) !==
              quote.preview ||
            (quote.targetId !== undefined &&
              (!Number.isInteger(quote.targetId) ||
                !messageIds.has(quote.targetId)))
          ) {
            return true;
          }
          return false;
        })
      ) {
        throw this.invalidWire('invalid forward quote descriptor');
      }
      visiting.add(id);
      const childDepth = bundle.manifest.children.reduce(
        (max, child) => Math.max(max, depthOf(child)),
        0,
      );
      visiting.delete(id);
      const depth = childDepth + 1;
      if (
        depth > FORWARD_MAX_DEPTH ||
        bundle.depth !== depth ||
        bundle.manifest.depth !== depth
      ) {
        throw this.invalidWire('forward nesting depth is invalid');
      }
      calculated.set(id, depth);
      return depth;
    };
    depthOf(closure.rootBundleId);
    if (calculated.size !== remote.size) {
      throw this.invalidWire('wire contains bundles outside the root closure');
    }
    const derivedAssets = this.assetsFromClosure(closure);
    for (const asset of closure.assets) this.validateWireAsset(asset);
    const declaredAssets = new Map(
      closure.assets.map((asset) => [this.assetKey(asset), asset]),
    );
    if (
      declaredAssets.size !== derivedAssets.length ||
      derivedAssets.some((asset) => {
        const declared = declaredAssets.get(this.assetKey(asset));
        return (
          !declared ||
          declared.extension !== asset.extension ||
          declared.bytes !== asset.bytes ||
          declared.filename !== asset.filename ||
          declared.mime !== asset.mime
        );
      })
    ) {
      throw this.invalidWire(
        'forward closure asset summary does not match its bundles',
      );
    }

    const client = transaction ?? this.database.db;
    const [existing] = await client
      .select({ id: forwardBundle.id })
      .from(forwardBundle)
      .where(
        and(
          eq(forwardBundle.sourceDomain, sourceDomain),
          eq(forwardBundle.sourceBundleId, closure.rootBundleId),
        ),
      )
      .limit(1);
    if (existing) return { localRootBundleId: existing.id };

    const orderedBundles = [...closure.bundles].sort(
      (a, b) => calculated.get(a.id)! - calculated.get(b.id)!,
    );
    const idMap = new Map<string, string>(
      orderedBundles.map((bundle) => [bundle.id, mintUlid()]),
    );
    const persist = async (tx: DatabaseTransaction) => {
      for (const wire of orderedBundles) {
        const localId = idMap.get(wire.id)!;
        const localManifest: ForwardManifest = {
          ...wire.manifest,
          bundleId: localId,
          children: wire.manifest.children.map((child) => idMap.get(child)!),
          messages: wire.manifest.messages.map((message) => ({
            ...message,
            content: projectForwardContentFromWire(
              message.contentType,
              message.content,
            ),
            ...(message.childBundleId
              ? { childBundleId: idMap.get(message.childBundleId)! }
              : {}),
          })),
        };
        await tx.insert(forwardBundle).values({
          id: localId,
          depth: calculated.get(wire.id)!,
          manifest: localManifest,
          manifestDigest: digestManifest(localManifest),
          messageCount: localManifest.messages.length,
          assetCount: wire.assets.length,
          totalBytes: wire.assets.reduce(
            (sum, asset) => sum + BigInt(asset.bytes),
            0n,
          ),
          sourceDomain,
          sourceBundleId: wire.id,
        });
        if (localManifest.children.length > 0) {
          await tx.insert(forwardBundleDependency).values(
            localManifest.children.map((childBundleId, ordinal) => ({
              parentBundleId: localId,
              childBundleId,
              ordinal,
            })),
          );
        }
        if (wire.assets.length > 0) {
          await tx.insert(forwardBundleAsset).values(
            wire.assets.map((asset, ordinal) => ({
              bundleId: localId,
              ordinal,
              digest: asset.digest,
              kind: asset.kind,
              extension: asset.extension,
              bytes: BigInt(asset.bytes),
              filename: asset.filename,
              mime: asset.mime,
            })),
          );
        }
      }
    };
    if (transaction) await persist(transaction);
    else await this.database.db.transaction(persist);
    return { localRootBundleId: idMap.get(closure.rootBundleId)! };
  }

  private async assetsFromContent(
    contentType: ContentType,
    content: string,
  ): Promise<ForwardAssetDocument[]> {
    if (contentType === ContentType.GALLERY) {
      return this.galleryAssetsFromContent(content);
    }
    const kind =
      contentType === ContentType.IMAGE
        ? 'image'
        : contentType === ContentType.FILE
          ? 'file'
          : contentType === ContentType.VIDEO
            ? 'video'
            : contentType === ContentType.AUDIO
              ? 'audio'
              : contentType === ContentType.LINK
                ? 'link'
                : null;
    if (!kind) return [];
    let meta: { name?: string; mimeType?: string; size?: number } = {};
    try {
      meta = JSON.parse(content) as typeof meta;
    } catch {
      // IMAGE legacy content may not be JSON; digest extraction remains authoritative.
    }
    const result: ForwardAssetDocument[] = [];
    for (const { digest, ext } of extractDigestEntries(content)) {
      const presentationExt = parseFileExt(meta.name ?? '') || ext || 'bin';
      const row = await this.database.db.query.mediaAsset.findFirst({
        where: eq(mediaAsset.digest, digest),
      });
      result.push({
        digest,
        kind,
        extension: presentationExt,
        bytes: Math.max(1, meta.size ?? Number(row?.bytes ?? 1n)),
        ...(meta.name ? { filename: meta.name } : {}),
        ...(meta.mimeType ? { mime: meta.mimeType } : {}),
      });
    }
    return result;
  }

  /** Build one ForwardAssetDocument per GALLERY item, each tagged with the item's own kind (a gallery may
   *  mix image/video/file/audio). Digest comes from the item's CAS url; bytes fall back to the live
   *  MediaAsset row when the item omits size. */
  private async galleryAssetsFromContent(
    content: string,
  ): Promise<ForwardAssetDocument[]> {
    let items: Array<Record<string, unknown>> = [];
    try {
      const parsed = JSON.parse(content) as { items?: unknown };
      if (Array.isArray(parsed.items)) {
        items = parsed.items as Array<Record<string, unknown>>;
      }
    } catch {
      // malformed gallery content → no assets
    }
    const result: ForwardAssetDocument[] = [];
    for (const item of items) {
      const url = typeof item['url'] === 'string' ? item['url'] : undefined;
      const digest = url ? extractDigests(url)[0] : undefined;
      if (!digest) continue;
      const k = item['kind'];
      const kind: ForwardAssetDocument['kind'] =
        k === 'IMAGE'
          ? 'image'
          : k === 'VIDEO'
            ? 'video'
            : k === 'AUDIO'
              ? 'audio'
              : 'file';
      const name = typeof item['name'] === 'string' ? item['name'] : undefined;
      const mimeType =
        typeof item['mimeType'] === 'string' ? item['mimeType'] : undefined;
      const size = typeof item['size'] === 'number' ? item['size'] : undefined;
      const row = await this.database.db.query.mediaAsset.findFirst({
        where: eq(mediaAsset.digest, digest),
      });
      result.push({
        digest,
        kind,
        extension: parseFileExt(name ?? '') || 'bin',
        bytes: Math.max(1, size ?? Number(row?.bytes ?? 1n)),
        ...(name ? { filename: name } : {}),
        ...(mimeType ? { mime: mimeType } : {}),
      });
    }
    return result;
  }

  private async snapshotAvatar(
    url: string,
  ): Promise<ForwardAssetDocument | null> {
    if (!url.startsWith('/uploads/')) return null;
    try {
      const source = join(
        process.cwd(),
        'data',
        'uploads',
        url.slice('/uploads/'.length),
      );
      const buffer = await readFile(source);
      const digest = createHash('sha256').update(buffer).digest('hex');
      const extension = extname(source).slice(1).toLowerCase() || 'webp';
      const target = join(
        process.cwd(),
        'data',
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
        kind: 'avatar',
        extension,
        bytes: buffer.length,
        mime: 'image/webp',
      };
    } catch {
      return null;
    }
  }

  private summaryLine(message: ForwardManifestMessage): string {
    const label =
      message.contentType === ContentType.IMAGE
        ? '[图片]'
        : message.contentType === ContentType.FILE
          ? '[文件]'
          : message.contentType === ContentType.VIDEO
            ? '[视频]'
            : message.contentType === ContentType.AUDIO
              ? '[语音]'
              : message.contentType === ContentType.GALLERY
                ? '[图集]'
                : message.contentType === ContentType.FORWARD
                  ? '[转发消息]'
                  : toDisplayText(
                      parseTextMessageContent(message.content)?.text ?? '',
                    )
                      .replace(/\s+/g, ' ')
                      .trim();
    return truncateGraphemes(
      `${message.sender.displayName}：${label}`,
      FORWARD_SUMMARY_CHARS,
    );
  }

  private assetDocument(asset: {
    digest: string;
    kind: string;
    extension: string;
    bytes: bigint;
    filename: string | null;
    mime: string | null;
  }): ForwardAssetDocument {
    return {
      digest: asset.digest,
      kind: asset.kind as ForwardAssetDocument['kind'],
      extension: asset.extension,
      bytes: Number(asset.bytes),
      ...(asset.filename ? { filename: asset.filename } : {}),
      ...(asset.mime ? { mime: asset.mime } : {}),
    };
  }

  private assetKey(asset: ForwardAssetDocument): string {
    return asset.digest;
  }

  private validateWireAsset(asset: ForwardAssetDocument): void {
    if (
      !/^[0-9a-f]{64}$/.test(asset.digest) ||
      !/^[A-Za-z0-9]{1,16}$/.test(asset.extension) ||
      !Number.isSafeInteger(asset.bytes) ||
      asset.bytes < 1 ||
      !['avatar', 'image', 'file', 'video', 'audio', 'link'].includes(
        asset.kind,
      )
    ) {
      throw this.invalidWire('invalid forward asset descriptor');
    }
  }

  assetsFromClosure(closure: ForwardWireClosure): ForwardAssetDocument[] {
    const assets = new Map<string, ForwardAssetDocument>();
    for (const bundle of closure.bundles) {
      for (const asset of bundle.assets) {
        assets.set(this.assetKey(asset), asset);
      }
    }
    return [...assets.values()];
  }

  private invalidWire(message: string): BusinessException {
    return new BusinessException(
      BusinessCode.FEDERATION_MALFORMED,
      message,
      HttpStatus.BAD_REQUEST,
    );
  }
}

export function digestManifest(manifest: ForwardManifest): string {
  return createHash('sha256').update(canonicalJson(manifest)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
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

function forwardMediaKind(
  contentType: string,
): ForwardAssetDocument['kind'] | null {
  return contentType === ContentType.IMAGE
    ? 'image'
    : contentType === ContentType.FILE
      ? 'file'
      : contentType === ContentType.VIDEO
        ? 'video'
        : contentType === ContentType.AUDIO
          ? 'audio'
          : null;
}

function isFederatedContentType(value: string): value is ContentType {
  return Object.values(ContentType).includes(value as ContentType);
}

function projectForwardContentToWire(
  contentType: string,
  content: string,
): string {
  if (!isFederatedContentType(contentType)) return content;
  return toFederatedMessageContent(contentType, content);
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
  assets: ForwardAssetDocument[],
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
  const kind = forwardMediaKind(contentType);
  if (!kind) return content;
  const digests = extractDigests(content);
  const asset =
    digests.length === 1
      ? assets.find(
          (candidate) =>
            candidate.kind === kind && candidate.digest === digests[0],
        )
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
