import { Injectable, signal } from '@angular/core';
import type { NamespaceRecord } from './webdb.service';

/** Reactive client projection of the nullable active namespace for each federation domain. */
@Injectable({ providedIn: 'root' })
export class FederationNamespaceService {
  private readonly activeByDomain = signal<ReadonlyMap<string, number | null>>(
    new Map([['local', 0]]),
  );

  replace(records: readonly NamespaceRecord[]): void {
    const next = new Map<string, number | null>([['local', 0]]);
    for (const record of records) {
      if (record.status === 'ACTIVE') next.set(record.domain, record.namespaceId);
      else if (!next.has(record.domain)) next.set(record.domain, null);
    }
    this.activeByDomain.set(next);
  }

  archive(domain: string, namespaceId: number): void {
    const next = new Map(this.activeByDomain());
    if (next.get(domain) === namespaceId) next.set(domain, null);
    this.activeByDomain.set(next);
  }

  activeNamespaceId(domain: string): number | null | undefined {
    return this.activeByDomain().get(domain);
  }

  isActive(domain: string, namespaceId: number): boolean {
    return namespaceId === 0 || this.activeByDomain().get(domain) === namespaceId;
  }

  displayDomain(domain: string, namespaceId: number): string {
    return this.isActive(domain, namespaceId)
      ? domain
      : `${namespaceId}.${domain}.local`;
  }
}
