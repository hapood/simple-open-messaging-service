import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { asc, desc, eq } from 'drizzle-orm';
import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseService } from '../database/database.service.js';
import { linkCardRule, linkFavicon } from '../database/schema.js';
import { UploadService } from '../upload/upload.service.js';
import { SafeFetchService } from './safe-fetch.service.js';

export interface ClientLinkCardRule {
  id: number;
  matchUrl: string;
  hostname: string;
  displayName: string;
  includeSubdomains: boolean;
}

export interface ManagedLinkCardRule extends ClientLinkCardRule {
  enabled: boolean;
  priority: number;
  faviconUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LinkCardRuleInput {
  matchUrl: string;
  displayName: string;
  includeSubdomains: boolean;
  enabled: boolean;
  priority: number;
}

@Injectable()
export class LinkCardRuleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LinkCardRuleService.name);
  private readonly inFlight = new Map<number, Promise<string>>();

  constructor(
    private readonly database: DatabaseService,
    private readonly fetcher: SafeFetchService,
    private readonly uploads: UploadService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const path = resolve(
      process.env.LINK_CARD_RULES_FILE ?? 'config/link-card-rules.json',
    );
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
      if (!Array.isArray(parsed)) throw new Error('root must be an array');
      let inserted = 0;
      for (const item of parsed) {
        const input = parseConfigRule(item);
        const hostname = hostnameFor(input.matchUrl);
        const rows = await this.database.db
          .insert(linkCardRule)
          .values({ ...input, hostname })
          .onConflictDoNothing({ target: linkCardRule.hostname })
          .returning({ id: linkCardRule.id });
        inserted += rows.length;
      }
      this.logger.log(
        `link-card defaults loaded (${inserted} inserted, ${parsed.length - inserted} already present)`,
      );
    } catch (error) {
      this.logger.warn(
        `link-card defaults not loaded from ${path}: ${(error as Error).message}`,
      );
    }
  }

  async list(): Promise<ClientLinkCardRule[]> {
    return this.database.db
      .select({
        id: linkCardRule.id,
        matchUrl: linkCardRule.matchUrl,
        hostname: linkCardRule.hostname,
        displayName: linkCardRule.displayName,
        includeSubdomains: linkCardRule.includeSubdomains,
      })
      .from(linkCardRule)
      .where(eq(linkCardRule.enabled, true))
      .orderBy(desc(linkCardRule.priority), asc(linkCardRule.id));
  }

  async listManaged(): Promise<ManagedLinkCardRule[]> {
    const rows = await this.database.db
      .select({
        id: linkCardRule.id,
        matchUrl: linkCardRule.matchUrl,
        hostname: linkCardRule.hostname,
        displayName: linkCardRule.displayName,
        includeSubdomains: linkCardRule.includeSubdomains,
        enabled: linkCardRule.enabled,
        priority: linkCardRule.priority,
        digest: linkFavicon.digest,
        createdAt: linkCardRule.createdAt,
        updatedAt: linkCardRule.updatedAt,
      })
      .from(linkCardRule)
      .leftJoin(linkFavicon, eq(linkFavicon.ruleId, linkCardRule.id))
      .orderBy(desc(linkCardRule.priority), asc(linkCardRule.id));
    return rows.map(({ digest, ...row }) => ({
      ...row,
      faviconUrl: digest ? this.contentUrl(digest) : null,
    }));
  }

  async create(input: LinkCardRuleInput): Promise<ManagedLinkCardRule> {
    const hostname = hostnameFor(input.matchUrl);
    try {
      const [created] = await this.database.db
        .insert(linkCardRule)
        .values({ ...input, hostname })
        .returning({ id: linkCardRule.id });
      return this.getManaged(created.id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('hostname already exists');
      }
      throw error;
    }
  }

  async update(
    id: number,
    input: LinkCardRuleInput,
  ): Promise<ManagedLinkCardRule> {
    const hostname = hostnameFor(input.matchUrl);
    const current = await this.database.db.query.linkCardRule.findFirst({
      where: eq(linkCardRule.id, id),
      columns: { matchUrl: true },
    });
    if (!current) throw new NotFoundException('link card rule not found');
    try {
      await this.database.db.transaction(async (tx) => {
        await tx
          .update(linkCardRule)
          .set({ ...input, hostname, updatedAt: new Date() })
          .where(eq(linkCardRule.id, id));
        if (current.matchUrl !== input.matchUrl) {
          await tx.delete(linkFavicon).where(eq(linkFavicon.ruleId, id));
        }
      });
      return this.getManaged(id);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException('hostname already exists');
      }
      throw error;
    }
  }

  async remove(id: number): Promise<{ deleted: boolean }> {
    const rows = await this.database.db
      .delete(linkCardRule)
      .where(eq(linkCardRule.id, id))
      .returning({ id: linkCardRule.id });
    if (!rows.length) throw new NotFoundException('link card rule not found');
    return { deleted: true };
  }

  private async getManaged(id: number): Promise<ManagedLinkCardRule> {
    const row = (await this.listManaged()).find((item) => item.id === id);
    if (!row) throw new NotFoundException('link card rule not found');
    return row;
  }

  async faviconUrl(ruleId: number): Promise<string> {
    const existing = await this.database.db.query.linkFavicon.findFirst({
      where: eq(linkFavicon.ruleId, ruleId),
      columns: { digest: true },
    });
    if (existing) return this.contentUrl(existing.digest);
    const running = this.inFlight.get(ruleId);
    if (running) return running;
    const work = this.fetchAndStore(ruleId).finally(() =>
      this.inFlight.delete(ruleId),
    );
    this.inFlight.set(ruleId, work);
    return work;
  }

  async content(digest: string): Promise<Buffer> {
    const ref = await this.database.db.query.linkFavicon.findFirst({
      where: eq(linkFavicon.digest, digest),
      columns: { digest: true },
    });
    const path = ref && this.uploads.casPath(digest);
    if (!path) throw new NotFoundException('favicon not found');
    try {
      return await readFile(path);
    } catch {
      throw new NotFoundException('favicon not found');
    }
  }

  private async fetchAndStore(ruleId: number): Promise<string> {
    const rule = await this.database.db.query.linkCardRule.findFirst({
      where: eq(linkCardRule.id, ruleId),
    });
    if (!rule?.enabled) throw new NotFoundException('link card rule not found');
    const sourceUrl = await this.discoverFavicon(rule.matchUrl);
    const source = await this.fetcher.fetchImage(sourceUrl);
    if (!source) throw new NotFoundException('favicon unavailable');
    const webp = await sharp(source.buf, {
      density: 192,
      limitInputPixels: 4_194_304,
    })
      .rotate()
      .resize(64, 64, { fit: 'contain', withoutEnlargement: true })
      .webp({ quality: 88, alphaQuality: 90 })
      .toBuffer();
    const saved = await this.uploads.saveGeneratedWebp(webp);
    await this.database.db
      .insert(linkFavicon)
      .values({ ruleId, sourceUrl, digest: saved.digest })
      .onConflictDoUpdate({
        target: linkFavicon.ruleId,
        set: { sourceUrl, digest: saved.digest, updatedAt: new Date() },
      });
    return this.contentUrl(saved.digest);
  }

  private async discoverFavicon(matchUrl: string): Promise<string> {
    const page = await this.fetcher.fetchHtml(matchUrl);
    if (page) {
      const links = page.body.matchAll(/<link\b[^>]*>/gi);
      for (const match of links) {
        const tag = match[0];
        const rel = attribute(tag, 'rel')?.toLowerCase() ?? '';
        if (
          !rel
            .split(/\s+/)
            .some((value) => value === 'icon' || value === 'shortcut')
        )
          continue;
        const href = attribute(tag, 'href');
        if (href) {
          try {
            return new URL(href, page.finalUrl).href;
          } catch {
            /* try the conventional path */
          }
        }
      }
      return new URL('/favicon.ico', page.finalUrl).href;
    }
    return new URL('/favicon.ico', matchUrl).href;
  }

  private contentUrl(digest: string): string {
    return `/uploads/link-favicons/${digest}.webp`;
  }
}

function hostnameFor(matchUrl: string): string {
  const url = new URL(matchUrl);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('matchUrl must use http or https');
  }
  return url.hostname.toLowerCase().replace(/^www\./, '');
}

function parseConfigRule(value: unknown): LinkCardRuleInput {
  if (!value || typeof value !== 'object') throw new Error('invalid rule');
  const item = value as Record<string, unknown>;
  if (
    typeof item.matchUrl !== 'string' ||
    typeof item.displayName !== 'string'
  ) {
    throw new Error('each rule needs matchUrl and displayName');
  }
  hostnameFor(item.matchUrl);
  return {
    matchUrl: item.matchUrl,
    displayName: item.displayName,
    includeSubdomains: item.includeSubdomains !== false,
    enabled: item.enabled !== false,
    priority:
      typeof item.priority === 'number' && Number.isInteger(item.priority)
        ? item.priority
        : 0,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(
    `\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'i',
  ).exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}
