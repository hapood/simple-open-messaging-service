import { Injectable } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import {
  DatabaseService,
  type DatabaseTransaction,
} from '../database/database.service.js';
import {
  federationQuotaPolicy,
  identityNamespace,
} from '../database/schema.js';
import { BusinessException } from '../common/business.exception.js';
import { BusinessCode } from '../common/business-code.js';
import {
  policyView,
  type QuotaPolicyView,
  normalizeOverrides,
  type QuotaOverrides,
} from './quota-policy.js';
import { DEFAULT_MAX_FILE_BYTES } from './quota-policy.js';
import type { QuotaCountDimension } from './daily-quota-ledger.js';
import { QuotaRuntime, type QuotaUsage } from './quota-runtime.js';
export type { QuotaCountDimension } from './daily-quota-ledger.js';
export type { QuotaOverrides } from './quota-policy.js';
export type { BreakerStatus } from './quota-runtime.js';

@Injectable()
export class QuotaService extends QuotaRuntime {
  constructor(database: DatabaseService) {
    super(
      database,
      {
        maxFileBytes: DEFAULT_MAX_FILE_BYTES,
        dailyRequestLimit: 1000,
        dailyMsgLimit: 5000,
        dailySignalLimit: 50_000,
        dailyFileLimit: 500,
        dailyFileBytesLimit: 5 * 1024 ** 3,
      },
      'quota:federation:',
      'peer',
    );
  }
  protected async key(id: number): Promise<string> {
    return String(id);
  }
  protected async loadPolicy(
    key: string,
    tx?: DatabaseTransaction,
  ): Promise<QuotaOverrides> {
    return (
      (await (tx ?? this.database.db).query.federationQuotaPolicy.findFirst({
        where: eq(federationQuotaPolicy.nsid, Number(key)),
      })) ?? {}
    );
  }
  async activeNamespaceId(domain: string): Promise<number> {
    const peer = await this.database.db.query.identityNamespace.findFirst({
      where: and(
        eq(identityNamespace.domain, domain),
        eq(identityNamespace.active, true),
      ),
      columns: { id: true },
    });
    if (!peer)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'active quota namespace not found',
      );
    return peer.id;
  }
  async setLimits(nsid: number, input: QuotaOverrides): Promise<void> {
    const peer = await this.database.db.query.identityNamespace.findFirst({
      where: eq(identityNamespace.id, nsid),
      columns: { id: true },
    });
    if (!peer || nsid <= 0)
      throw new BusinessException(
        BusinessCode.NOT_FOUND,
        'quota namespace not found',
      );
    const values = normalizeOverrides(input);
    await this.database.db
      .insert(federationQuotaPolicy)
      .values({ nsid, ...values })
      .onConflictDoUpdate({
        target: federationQuotaPolicy.nsid,
        set: { ...values, updatedAt: new Date() },
      });
  }
  async listNodes(): Promise<QuotaNode[]> {
    const peers = await this.database.db.query.identityNamespace.findMany({
      orderBy: asc(identityNamespace.domain),
      columns: { id: true, domain: true, active: true, trustLevel: true },
    });
    return Promise.all(
      peers
        .filter((p) => p.id > 0 && p.active)
        .map(async (p) => ({
          domain: p.domain,
          namespaceId: p.id,
          trustLevel: p.trustLevel,
          overrides: policyView(await this.getOverrides(p.id)),
          usage: await this.usageToday(p.id),
          breaker: await this.breakerStatus(p.id),
        })),
    );
  }
  async trippedBreakers() {
    return (
      await Promise.all(
        (await this.listNodes()).map(async (node) => ({
          ...(await this.breakerStatus(node.namespaceId)),
          entity: node.domain,
        })),
      )
    ).filter((s) => s.tripped);
  }
}
export interface QuotaNode {
  domain: string;
  namespaceId: number;
  trustLevel: string;
  overrides: QuotaPolicyView;
  usage: Record<QuotaCountDimension, QuotaUsage>;
  breaker: import('./quota-runtime.js').BreakerStatus;
}
