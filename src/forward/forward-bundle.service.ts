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
  /** Canonical 1-based Bundle-local id. Optional in the type only for pre-quote v1 bundles. */
  id?: number;
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
  quotaMessageCount: number;
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
    if (isAttachedMedia || visible.contentType === ContentType.LINK) {
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
    const quotaMessageCount =
      messages.length +
      [...descendantBundles.values()].reduce(
        (sum, bundle) => sum + bundle.manifest.messages.length,
        0,
      );
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
      quotaMessageCount,
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
          sql`${message.seq} > COALESCE(${threadParticipant.clearedSeq}, -1)`,
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
      return {
        id: row.id,
        depth: row.depth,
        manifestDigest: row.manifestDigest,
        manifest: row.manifest as unknown as ForwardManifest,
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
        HttpStatus.PAYLOAD_TOO_LARGE,
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
      // v1 bundles created before quote snapshots had no message ids. Continue accepting that legacy
      // shape; once any id is present, the complete manifest must use the canonical 1-based sequence.
      const usesMessageIds = bundle.manifest.messages.some(
        (message) => message.id !== undefined,
      );
      for (const [
        messageIndex,
        message,
      ] of bundle.manifest.messages.entries()) {
        if (
          (usesMessageIds && message.id !== messageIndex + 1) ||
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
        const mediaKind = forwardMediaKind(message.contentType);
        if (mediaKind) {
          let mediaContent: unknown;
          try {
            mediaContent = JSON.parse(message.content);
          } catch {
            throw this.invalidWire('invalid forward media content');
          }
          if (
            typeof mediaContent !== 'object' ||
            mediaContent === null ||
            Array.isArray(mediaContent) ||
            typeof (mediaContent as Record<string, unknown>)['url'] !== 'string'
          ) {
            throw this.invalidWire('invalid forward media content');
          }
          const digests = extractDigests(message.content);
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
      }
      const messageIds = new Set(
        bundle.manifest.messages.flatMap((message) =>
          message.id === undefined ? [] : [message.id],
        ),
      );
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
            content: localizeForwardMediaContent(
              message.contentType,
              message.content,
              wire.assets,
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
      await this.database.db
        .insert(mediaAsset)
        .values({
          digest,
          bytes: BigInt(buffer.length),
          status: 'PENDING',
        })
        .onConflictDoNothing({ target: mediaAsset.digest });
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
        .update(mediaAsset)
        .set({
          status: 'READY',
          bytes: BigInt(buffer.length),
          stateChangedAt: sql`CURRENT_TIMESTAMP`,
        })
        .where(eq(mediaAsset.digest, digest));
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
    return `${asset.kind}:${asset.digest}`;
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

/**
 * A localized bundle never retains the source server's media URL. The digest is the wire identity;
 * rebuild the complete server-relative CAS path from the validated bundle asset.
 */
export function localizeForwardMediaContent(
  contentType: string,
  content: string,
  assets: ForwardAssetDocument[],
): string {
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
