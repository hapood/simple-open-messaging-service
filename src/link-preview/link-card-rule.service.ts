import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { asc, eq, inArray } from 'drizzle-orm';
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
export class LinkCardRuleService {
  constructor(private readonly database: DatabaseService) {}

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

function isUniqueViolation(error: unknown): boolean {
  return (
    !!error &&
    typeof error === 'object' &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}
