import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseService } from '../database/database.service.js';
import { linkCardRule } from '../database/schema.js';

export interface ClientLinkCardRule {
  id: number;
  hostname: string;
}

export interface ManagedLinkCardRule extends ClientLinkCardRule {
  note: string | null;
  imageSelection: 'first' | 'last';
  descriptionSelection: 'first' | 'last';
  createdAt: Date;
  updatedAt: Date;
}

export interface LinkCardRuleInput {
  hostname: string;
  note?: string;
  imageSelection?: 'first' | 'last';
  descriptionSelection?: 'first' | 'last';
}

@Injectable()
export class LinkCardRuleService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LinkCardRuleService.name);

  constructor(private readonly database: DatabaseService) {}

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
        const rows = await this.database.db
          .insert(linkCardRule)
          .values(input)
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

  list(): Promise<ClientLinkCardRule[]> {
    return this.database.db
      .select({ id: linkCardRule.id, hostname: linkCardRule.hostname })
      .from(linkCardRule)
      .orderBy(asc(linkCardRule.hostname));
  }

  listManaged(): Promise<ManagedLinkCardRule[]> {
    return this.database.db
      .select({
        id: linkCardRule.id,
        hostname: linkCardRule.hostname,
        note: linkCardRule.note,
        imageSelection: linkCardRule.imageSelection,
        descriptionSelection: linkCardRule.descriptionSelection,
        createdAt: linkCardRule.createdAt,
        updatedAt: linkCardRule.updatedAt,
      })
      .from(linkCardRule)
      .orderBy(asc(linkCardRule.hostname));
  }

  async metadataSelectionsForUrl(rawUrl: string): Promise<{
    image: 'first' | 'last';
    description: 'first' | 'last';
  }> {
    let hostname: string;
    try {
      hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, '');
    } catch {
      return { image: 'first', description: 'first' };
    }
    const labels = hostname.split('.');
    const candidates = labels
      .map((_, index) => labels.slice(index).join('.'))
      .filter((candidate) => candidate.includes('.'));
    const rows = await this.database.db
      .select({
        hostname: linkCardRule.hostname,
        imageSelection: linkCardRule.imageSelection,
        descriptionSelection: linkCardRule.descriptionSelection,
      })
      .from(linkCardRule)
      .where(inArray(linkCardRule.hostname, candidates));
    const row = rows.sort(
      (left, right) => right.hostname.length - left.hostname.length,
    )[0];
    return {
      image: row?.imageSelection ?? 'first',
      description: row?.descriptionSelection ?? 'first',
    };
  }

  async create(input: LinkCardRuleInput): Promise<ManagedLinkCardRule> {
    const value = normalizeInput(input);
    try {
      const [created] = await this.database.db
        .insert(linkCardRule)
        .values(value)
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
    try {
      const rows = await this.database.db
        .update(linkCardRule)
        .set({ ...normalizeInput(input), updatedAt: new Date() })
        .where(eq(linkCardRule.id, id))
        .returning({ id: linkCardRule.id });
      if (!rows.length) throw new NotFoundException('link card rule not found');
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
    const row = await this.database.db.query.linkCardRule.findFirst({
      where: eq(linkCardRule.id, id),
    });
    if (!row) throw new NotFoundException('link card rule not found');
    return row;
  }
}

function normalizeInput(input: LinkCardRuleInput): LinkCardRuleInput {
  return {
    hostname: input.hostname.toLowerCase().replace(/^www\./, ''),
    note: input.note?.trim() || undefined,
    imageSelection: input.imageSelection ?? 'first',
    descriptionSelection: input.descriptionSelection ?? 'first',
  };
}

function parseConfigRule(value: unknown): LinkCardRuleInput {
  if (!value || typeof value !== 'object') throw new Error('invalid rule');
  const item = value as Record<string, unknown>;
  if (typeof item.hostname !== 'string') {
    throw new Error('each rule needs hostname');
  }
  return normalizeInput({
    hostname: item.hostname,
    note: typeof item.note === 'string' ? item.note : undefined,
    imageSelection:
      item.imageSelection === 'last' || item.imageSelection === 'first'
        ? item.imageSelection
        : undefined,
    descriptionSelection:
      item.descriptionSelection === 'last' ||
      item.descriptionSelection === 'first'
        ? item.descriptionSelection
        : undefined,
  });
}

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
