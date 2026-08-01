import { HttpStatus, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { mintUlid } from '../common/account.js';
import { BusinessCode } from '../common/business-code.js';
import { BusinessException } from '../common/business.exception.js';
import { PrismaService } from '../prisma.service.js';
import { ContentType, Prisma } from '../prisma/generated/client.js';
import { extractDigestEntries } from '../upload/file-content.js';
import { toDisplayText } from '../common/message-entity.js';
import { parseTextMessageContent } from '../../shared/text-message-content.js';

export const FORWARD_MAX_DEPTH = 3;
export const FORWARD_MAX_MESSAGES = 100;
export const FORWARD_SUMMARY_LINES = 3;
export const FORWARD_SUMMARY_CHARS = 100;
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
}

export interface PreparedForwardBundle {
  bundleId: string;
  depth: number;
  content: string;
  manifest: ForwardManifest;
  manifestDigest: string;
  assets: ForwardAssetDocument[];
  createdBy: number;
}

@Injectable()
export class ForwardBundleService {
  constructor(private readonly prisma: PrismaService) {}

  async createFromMessages(
    userId: number,
    sources: ForwardSourceMessage[],
  ): Promise<{
    bundleId: string;
    depth: number;
    content: string;
  }> {
    const prepared = await this.prepareFromMessages(userId, sources);
    await this.prisma.$transaction((tx) => this.persistPrepared(tx, prepared));
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
    const uniqueThreads = [...new Set(sources.map((s) => s.threadId))];
    const memberships = await this.prisma.threadParticipant.count({
      where: {
        userId,
        threadId: { in: uniqueThreads },
        leftAt: null,
      },
    });
    if (memberships !== uniqueThreads.length) {
      throw new BusinessException(
        BusinessCode.FORWARD_INVALID_BUNDLE,
        'one or more source messages are inaccessible',
      );
    }
    const sourceRows = await Promise.all(
      sources.map((source) =>
        this.prisma.message.findUnique({
          where: {
            threadId_seq: { threadId: source.threadId, seq: source.seq },
          },
          include: {
            creatorItem: {
              select: {
                account: true,
                domain: true,
                name: true,
                avatar: true,
              },
            },
            forwardMessage: {
              include: { bundle: true },
            },
          },
        }),
      ),
    );
    if (sourceRows.some((row) => row === null || row.isDeleted)) {
      throw new BusinessException(
        BusinessCode.FORWARD_INVALID_BUNDLE,
        'one or more source messages do not exist',
      );
    }

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
    const messages: ForwardManifestMessage[] = [];
    for (const row of sourceRows) {
      const message = row!;
      const avatar = await this.snapshotAvatar(message.creatorItem.avatar);
      if (avatar) assets.set(this.assetKey(avatar), avatar);
      const mediaAssets = await this.assetsFromContent(
        message.contentType,
        message.content,
      );
      for (const asset of mediaAssets) assets.set(this.assetKey(asset), asset);
      messages.push({
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
        content: message.content,
        sentAt: message.createdAt.getTime(),
        ...(message.forwardMessage
          ? { childBundleId: message.forwardMessage.bundleId }
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
    };
  }

  async persistPrepared(
    tx: Prisma.TransactionClient,
    prepared: PreparedForwardBundle,
  ): Promise<void> {
    await tx.forwardBundle.create({
      data: {
        id: prepared.bundleId,
        depth: prepared.depth,
        manifest: prepared.manifest as unknown as Prisma.InputJsonValue,
        manifestDigest: prepared.manifestDigest,
        messageCount: prepared.manifest.messages.length,
        assetCount: prepared.assets.length,
        totalBytes: prepared.assets.reduce(
          (sum, asset) => sum + BigInt(asset.bytes),
          0n,
        ),
        createdBy: prepared.createdBy,
      },
    });
    if (prepared.manifest.children.length > 0) {
      await tx.forwardBundleDependency.createMany({
        data: prepared.manifest.children.map((childBundleId, ordinal) => ({
          parentBundleId: prepared.bundleId,
          childBundleId,
          ordinal,
        })),
      });
    }
    if (prepared.assets.length > 0) {
      for (const asset of prepared.assets) {
        await tx.mediaAsset.update({
          where: { digest: asset.digest },
          data: { refs: { increment: 1 } },
        });
      }
      await tx.forwardBundleAsset.createMany({
        data: prepared.assets.map((asset, ordinal) => ({
          bundleId: prepared.bundleId,
          ordinal,
          digest: asset.digest,
          kind: asset.kind,
          extension: asset.extension,
          bytes: BigInt(asset.bytes),
          filename: asset.filename,
          mime: asset.mime,
        })),
      });
    }
  }

  async getClosureForUser(
    userId: number,
    rootBundleId: string,
  ): Promise<ForwardWireClosure> {
    const visible = await this.prisma.forwardMessage.findFirst({
      where: {
        bundleId: rootBundleId,
        message: {
          threadItem: {
            ThreadParticipant: { some: { userId, leftAt: null } },
          },
          isDeleted: false,
        },
      },
      select: { messageId: true },
    });
    if (!visible) {
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'forward bundle not found',
      );
    }
    return this.buildClosure(rootBundleId);
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
      const row = await this.prisma.forwardBundle.findUnique({
        where: { id },
        include: {
          children: { orderBy: { ordinal: 'asc' } },
        },
      });
      if (!row) throw this.invalidWire('forward child bundle is missing');
      for (const child of row.children) await visit(child.childBundleId);
      visiting.delete(id);
      visited.add(id);
      orderedIds.push(id);
    };
    await visit(rootBundleId);
    const rows = await this.prisma.forwardBundle.findMany({
      where: { id: { in: orderedIds } },
      include: { assets: { orderBy: { ordinal: 'asc' } } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const bundles = orderedIds.map((id) => {
      const row = byId.get(id)!;
      return {
        id: row.id,
        depth: row.depth,
        manifestDigest: row.manifestDigest,
        manifest: row.manifest as unknown as ForwardManifest,
        assets: row.assets.map((asset) => this.assetDocument(asset)),
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
    transaction?: Prisma.TransactionClient,
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
      for (const message of bundle.manifest.messages) {
        if (
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

    const client = transaction ?? this.prisma;
    const existing = await client.forwardBundle.findUnique({
      where: {
        sourceDomain_sourceBundleId: {
          sourceDomain,
          sourceBundleId: closure.rootBundleId,
        },
      },
      select: { id: true },
    });
    if (existing) return { localRootBundleId: existing.id };

    const orderedBundles = [...closure.bundles].sort(
      (a, b) => calculated.get(a.id)! - calculated.get(b.id)!,
    );
    const idMap = new Map<string, string>(
      orderedBundles.map((bundle) => [bundle.id, mintUlid()]),
    );
    const persist = async (tx: Prisma.TransactionClient) => {
      for (const wire of orderedBundles) {
        const localId = idMap.get(wire.id)!;
        const localManifest: ForwardManifest = {
          ...wire.manifest,
          bundleId: localId,
          children: wire.manifest.children.map((child) => idMap.get(child)!),
          messages: wire.manifest.messages.map((message) => ({
            ...message,
            ...(message.childBundleId
              ? { childBundleId: idMap.get(message.childBundleId)! }
              : {}),
          })),
        };
        await tx.forwardBundle.create({
          data: {
            id: localId,
            depth: calculated.get(wire.id)!,
            manifest: localManifest as unknown as Prisma.InputJsonValue,
            manifestDigest: digestManifest(localManifest),
            messageCount: localManifest.messages.length,
            assetCount: wire.assets.length,
            totalBytes: wire.assets.reduce(
              (sum, asset) => sum + BigInt(asset.bytes),
              0n,
            ),
            sourceDomain,
            sourceBundleId: wire.id,
          },
        });
        if (localManifest.children.length > 0) {
          await tx.forwardBundleDependency.createMany({
            data: localManifest.children.map((childBundleId, ordinal) => ({
              parentBundleId: localId,
              childBundleId,
              ordinal,
            })),
          });
        }
        if (wire.assets.length > 0) {
          for (const asset of wire.assets) {
            // Existing local bytes gain one logical reference per bundle asset row. Missing assets are
            // localized after commit; saveCasFromStream creates their first ref there.
            await tx.mediaAsset.updateMany({
              where: { digest: asset.digest },
              data: { refs: { increment: 1 } },
            });
          }
          await tx.forwardBundleAsset.createMany({
            data: wire.assets.map((asset, ordinal) => ({
              bundleId: localId,
              ordinal,
              digest: asset.digest,
              kind: asset.kind,
              extension: asset.extension,
              bytes: BigInt(asset.bytes),
              filename: asset.filename,
              mime: asset.mime,
            })),
          });
        }
      }
    };
    if (transaction) await persist(transaction);
    else await this.prisma.$transaction(persist);
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
    let meta: { name?: string; mimeType?: string } = {};
    try {
      meta = JSON.parse(content) as typeof meta;
    } catch {
      // IMAGE legacy content may not be JSON; digest extraction remains authoritative.
    }
    const result: ForwardAssetDocument[] = [];
    for (const { digest, ext } of extractDigestEntries(content)) {
      const row = await this.prisma.mediaAsset.findUnique({
        where: { digest },
      });
      if (!row || row.refs <= 0) {
        throw new BusinessException(
          BusinessCode.FORWARD_INVALID_BUNDLE,
          'source attachment is unavailable',
        );
      }
      result.push({
        digest,
        kind,
        extension: ext,
        bytes: Number(row.bytes),
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
        'uploads',
        'shards',
        digest.slice(0, 2),
        digest.slice(2, 4),
        `${digest}.${extension}`,
      );
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${mintUlid()}.tmp`;
      await writeFile(temporary, buffer);
      await rename(temporary, target);
      await this.prisma.mediaAsset.upsert({
        where: { digest },
        create: { digest, bytes: BigInt(buffer.length), refs: 0 },
        update: {},
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
